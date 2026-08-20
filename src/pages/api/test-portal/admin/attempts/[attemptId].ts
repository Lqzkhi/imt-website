import type { APIRoute } from 'astro';
import { requireSameOrigin } from '../../../../../lib/requestGuards';
import { finalizeAttempt, finalizeIfExpired, logAdminAudit, logSecurityEvent, normalizeQuestionOptions, TEST_SUBMISSIONS_BUCKET, type AttemptRow, type QuestionRow, type ResponseRow } from '../../../../../lib/testPortal';
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

    return portalJson({
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
        attempt = await finalizeAttempt(supabase, attempt, 'submitted');
        await logAdminAudit(supabase, user.id, 'attempt_force_submitted', {
          test_id: attempt.test_id,
          attempt_id: attempt.id,
        });
      }
      return portalJson({ attempt });
    }

    if (action === 'extend_deadline') {
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
      const expiresAt = new Date(new Date(attempt.expires_at).getTime() + additionalMinutes * 60_000).toISOString();
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
    const { error: gradeError } = await supabase.from('test_responses').update({
      points_awarded: awarded,
      is_correct: awarded === maxPoints,
      grading_status: 'manually_graded',
      feedback,
      graded_by: user.id,
      graded_at: new Date().toISOString(),
    }).eq('id', response.id);
    if (gradeError) throw gradeError;

    const { data: allResponses, error: allError } = await supabase
      .from('test_responses')
      .select('points_awarded, grading_status, file_path')
      .eq('attempt_id', attempt.id);
    if (allError) throw allError;
    const score = (allResponses ?? []).reduce((sum, row) => sum + Number(row.points_awarded ?? 0), 0);
    const pendingManual = (allResponses ?? []).some((row) => row.file_path && row.grading_status !== 'manually_graded');
    const { data: updatedAttempt, error: updateError } = await supabase.from('test_attempts').update({
      score,
      grading_status: pendingManual ? 'pending_manual' : 'complete',
    }).eq('id', attempt.id).select('*').single();
    if (updateError) throw updateError;
    const metadata = {
      admin_user_id: user.id,
      previous_points: response.points_awarded === null ? null : Number(response.points_awarded),
      points_awarded: awarded,
      max_points: maxPoints,
      answer_type: question.answer_type,
    };
    await logSecurityEvent(supabase, attempt, 'grade_overridden_by_admin', {
      ...metadata,
      question_id: question.id,
      response_id: response.id,
    });
    await logAdminAudit(supabase, user.id, 'response_grade_overridden', {
      test_id: attempt.test_id,
      attempt_id: attempt.id,
      question_id: question.id,
      response_id: response.id,
    }, metadata);
    return portalJson({ attempt: updatedAttempt });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
