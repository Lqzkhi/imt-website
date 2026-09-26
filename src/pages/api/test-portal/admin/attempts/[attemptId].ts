import type { APIRoute } from 'astro';
import { requireSameOrigin } from '../../../../../lib/requestGuards';
import { calculateAttemptExpiry, finalizeAttempt, finalizeIfExpired, logAdminAudit, logSecurityEvent, normalizeQuestionOptions, TEST_SUBMISSIONS_BUCKET, type AttemptRow, type QuestionRow, type ResponseRow, type TestRow } from '../../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson, readPortalJson, stringField, uuidField } from '../../../../../lib/testPortalAuth';

async function getAdminAttempt(supabase: Awaited<ReturnType<typeof authenticatePortalRequest>>['supabase'], attemptId: string) {
  const { data, error } = await supabase.from('test_attempts').select('*').eq('id', attemptId).maybeSingle();
  if (error) throw error;
  if (!data) throw new PortalHttpError(404, 'ATTEMPT_NOT_FOUND', 'That attempt was not found.');
  return data as AttemptRow;
}

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const { supabase } = await authenticatePortalRequest(request, { admin: true });
    let attempt = await getAdminAttempt(supabase, params.attemptId ?? '');
    attempt = await finalizeIfExpired(supabase, attempt);
    const [{ data: test, error: testError }, { data: questions, error: questionError }, { data: responses, error: responseError }, { data: events, error: eventError }] = await Promise.all([
      supabase.from('tests').select('*').eq('id', attempt.test_id).single(),
      supabase.from('test_questions').select('*').eq('test_id', attempt.test_id).order('position'),
      supabase.from('test_responses').select('*').eq('attempt_id', attempt.id),
      supabase.from('test_security_events').select('*').eq('attempt_id', attempt.id).order('created_at'),
    ]);
    if (testError) throw testError;
    if (questionError) throw questionError;
    if (responseError) throw responseError;
    if (eventError) throw eventError;

    const questionRows = (questions ?? []) as QuestionRow[];
    const ids = questionRows.map((question) => question.id);
    const { data: keys, error: keyError } = ids.length
      ? await supabase.from('test_question_keys').select('*').in('question_id', ids)
      : { data: [], error: null };
    if (keyError) throw keyError;
    const keyMap = new Map((keys ?? []).map((key) => [key.question_id, key]));

    const responseRows = (responses ?? []) as ResponseRow[];
    const responseMap = new Map(responseRows.map((response) => [response.question_id, response]));
    const fileUrls = new Map<string, string>();
    await Promise.all(responseRows.filter((response) => response.file_path).map(async (response) => {
      const { data } = await supabase.storage
        .from(TEST_SUBMISSIONS_BUCKET)
        .createSignedUrl(response.file_path!, 3600);
      if (data?.signedUrl) fileUrls.set(response.id, data.signedUrl);
    }));

    const { data: scratchRows, error: scratchError } = await supabase.from('test_scratch_files').select('*').eq('attempt_id',attempt.id).order('created_at');
    if (scratchError) throw scratchError;
    const scratchFiles = await Promise.all((scratchRows ?? []).map(async (file) => {
      const { data, error } = await supabase.storage.from(TEST_SUBMISSIONS_BUCKET).createSignedUrl(file.file_path,600,{download:file.file_name});
      if (error) throw error;
      return { id:file.id, file_name:file.file_name, file_url:data.signedUrl, created_at:file.created_at };
    }));
    return portalJson({
      scratch_files: scratchFiles,
      test,
      attempt: {
        ...attempt,
        score: attempt.score === null ? null : Number(attempt.score),
        auto_score: attempt.auto_score === null ? null : Number(attempt.auto_score),
        max_score: Number(attempt.max_score),
        session_locked: Boolean(attempt.security_session_hash),
      },
      problems: questionRows.map((question) => {
        const response = responseMap.get(question.id);
        return {
          question: { ...question, options: normalizeQuestionOptions(question.options) },
          answer_key: keyMap.get(question.id) ?? null,
          response: response ? {
            ...response,
            points_awarded: response.points_awarded === null ? null : Number(response.points_awarded),
            file_url: fileUrls.get(response.id) ?? null,
          } : null,
        };
      }),
      events: events ?? [],
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

export const PATCH: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;
    const { supabase, user } = await authenticatePortalRequest(request, { admin: true });
    let attempt = await getAdminAttempt(supabase, params.attemptId ?? '');
    attempt = await finalizeIfExpired(supabase, attempt);
    const body = await readPortalJson(request);
    const action = stringField(body.action, 'action', { required: true, max: 80 });

    if (action === 'unlock_session') {
      if (attempt.status !== 'in_progress') {
        throw new PortalHttpError(409, 'ATTEMPT_CLOSED', 'Only an active one-sitting attempt can be unlocked.');
      }
      const { data, error } = await supabase
        .from('test_attempts')
        .update({ security_session_hash: null })
        .eq('id', attempt.id)
        .select('*')
        .single();
      if (error) throw error;
      await logSecurityEvent(supabase, attempt, 'session_unlocked_by_admin', { admin_user_id: user.id });
      await logAdminAudit(supabase, user.id, 'attempt_session_unlocked', {
        test_id: attempt.test_id,
        attempt_id: attempt.id,
      });
      return portalJson({ attempt: data });
    }

    if (action === 'force_submit') {
      if (attempt.status === 'in_progress') {
        attempt = await finalizeAttempt(supabase, attempt, 'admin_force');
        await logAdminAudit(supabase, user.id, 'attempt_force_submitted', {
          test_id: attempt.test_id,
          attempt_id: attempt.id,
        });
      }
      return portalJson({ attempt });
    }

    if (action === 'extend_deadline') {
      if (attempt.working_ended_at) throw new PortalHttpError(409, 'SOLVING_FINISHED', 'Solving has ended. The proof upload window cannot be extended or reopened.');
      if (attempt.status !== 'in_progress') {
        throw new PortalHttpError(409, 'ATTEMPT_CLOSED', 'Only an active attempt can receive more time.');
      }
      const additionalMinutes = Number(body.extension_minutes);
      const currentExtension = Number(attempt.extension_minutes ?? 0);
      if (!Number.isInteger(additionalMinutes) || additionalMinutes < 1 || additionalMinutes > 1440) {
        throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Add between 1 and 1,440 whole minutes at a time.');
      }
      if (currentExtension + additionalMinutes > 43_200) {
        throw new PortalHttpError(400, 'VALIDATION_ERROR', 'The total extension cannot exceed 30 days.');
      }
      const now = new Date().toISOString();
      const { data: testData, error: testError } = await supabase.from('tests').select('*').eq('id',attempt.test_id).single();
      if (testError) throw testError;
      const expiresAt = calculateAttemptExpiry(testData as TestRow, new Date(attempt.started_at), currentExtension + additionalMinutes).toISOString();
      if (expiresAt <= attempt.expires_at) throw new PortalHttpError(409,'CLOSING_TIME_LIMIT','Extend the contest closing time first; this attempt is already capped by it.');
      const { data: updatedAttempt, error } = await supabase
        .from('test_attempts')
        .update({
          expires_at: expiresAt,
          extension_minutes: currentExtension + additionalMinutes,
          deadline_extended_at: now,
          deadline_extended_by: user.id,
        })
        .eq('id', attempt.id)
        .eq('status', 'in_progress')
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!updatedAttempt) throw new PortalHttpError(409, 'ATTEMPT_CLOSED', 'The attempt closed before the extension was applied.');
      const metadata = {
        admin_user_id: user.id,
        added_minutes: additionalMinutes,
        total_extension_minutes: currentExtension + additionalMinutes,
        previous_expires_at: attempt.expires_at,
        expires_at: expiresAt,
      };
      await logSecurityEvent(supabase, attempt, 'deadline_extended_by_admin', metadata);
      await logAdminAudit(supabase, user.id, 'attempt_deadline_extended', {
        test_id: attempt.test_id,
        attempt_id: attempt.id,
      }, metadata);
      return portalJson({ attempt: updatedAttempt });
    }

    if (action !== 'manual_grade' && action !== 'override_grade') {
      throw new PortalHttpError(400, 'INVALID_ACTION', 'That review action is not supported.');
    }
    if (attempt.status === 'in_progress') {
      throw new PortalHttpError(409, 'ATTEMPT_ACTIVE', 'Submit the attempt before assigning a manual grade.');
    }

    const responseId = uuidField(body.response_id, 'response_id');
    const { data: response, error: responseError } = await supabase
      .from('test_responses')
      .select('*')
      .eq('id', responseId)
      .eq('attempt_id', attempt.id)
      .maybeSingle();
    if (responseError) throw responseError;
    if (!response) throw new PortalHttpError(404, 'RESPONSE_NOT_FOUND', 'That response was not found.');
    const { data: question, error: questionError } = await supabase
      .from('test_questions')
      .select('*')
      .eq('id', response.question_id)
      .single();
    if (questionError) throw questionError;

    const awarded = Number(body.points_awarded);
    const maxPoints = Number(question.points);
    if (!Number.isFinite(awarded) || awarded < 0 || awarded > maxPoints) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', `Points must be between 0 and ${maxPoints}.`);
    }
    const feedback = stringField(body.feedback, 'feedback', { max: 10_000 });
    const { data: updatedAttempt, error: gradeError } = await supabase.rpc('grade_test_response', {
      p_response_id: response.id, p_admin_id: user.id, p_points: awarded, p_feedback: feedback,
      p_expected_graded_at: body.expected_graded_at === undefined ? response.graded_at : body.expected_graded_at,
    }).single();
    if (gradeError) {
      if (gradeError.message.includes('Grade changed')) throw new PortalHttpError(409,'GRADE_CONFLICT','Another grader updated this response. Reload before saving.');
      throw gradeError;
    }
    return portalJson({ attempt: updatedAttempt });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
