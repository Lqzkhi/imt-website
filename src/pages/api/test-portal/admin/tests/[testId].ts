import type { APIRoute } from 'astro';
import { requireSameOrigin } from '../../../../../lib/requestGuards';
import { calculateAttemptExpiry, logAdminAudit, normalizeQuestionOptions, type QuestionRow, type TestRow } from '../../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson, readPortalJson, stringField } from '../../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const { supabase } = await authenticatePortalRequest(request, { admin: true });
    const testId = params.testId ?? '';
    const [{ data: test, error: testError }, { data: questions, error: questionError }, { count: attemptCount, error: attemptError }] = await Promise.all([
      supabase.from('tests').select('*').eq('id', testId).maybeSingle(),
      supabase.from('test_questions').select('*').eq('test_id', testId).order('position'),
      supabase.from('test_attempts').select('id', { count: 'exact', head: true }).eq('test_id', testId),
    ]);
    if (testError) throw testError;
    if (questionError) throw questionError;
    if (attemptError) throw attemptError;
    if (!test) throw new PortalHttpError(404, 'TEST_NOT_FOUND', 'That test was not found.');

    const questionRows = (questions ?? []) as QuestionRow[];
    const ids = questionRows.map((question) => question.id);
    const { data: keys, error: keyError } = ids.length
      ? await supabase.from('test_question_keys').select('*').in('question_id', ids)
      : { data: [], error: null };
    if (keyError) throw keyError;
    const keysById = new Map((keys ?? []).map((key) => [key.question_id, key]));

    return portalJson({
      test,
      attempt_count: attemptCount ?? 0,
      questions: questionRows.map((question) => ({
        ...question,
        options: normalizeQuestionOptions(question.options),
        answer_key: keysById.get(question.id) ?? null,
      })),
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
    const testId = params.testId ?? '';
    const body = await readPortalJson(request);
    const { data: existingTest, error: existingError } = await supabase.from('tests').select('*').eq('id', testId).maybeSingle();
    if (existingError) throw existingError;
    if (!existingTest) throw new PortalHttpError(404, 'TEST_NOT_FOUND', 'That test was not found.');

    const title = stringField(body.title, 'title', { required: true, max: 160 });
    const description = stringField(body.description, 'description', { max: 5_000 });
    const instructions = stringField(body.instructions_latex, 'instructions_latex', { max: 50_000 });
    const duration = Number(body.duration_minutes);
    if (!Number.isInteger(duration) || duration < 1 || duration > 43_200) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Duration must be between 1 and 43,200 minutes.');
    }
    const securityMode = stringField(body.security_mode, 'security_mode', { required: true });
    if (!['one_sitting', 'take_home'].includes(securityMode)) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Choose a valid security mode.');
    }
    const status = stringField(body.status, 'status', { required: true });
    if (!['draft', 'published', 'archived'].includes(status)) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Choose a valid test status.');
    }

    const parseDate = (value: unknown, label: string) => {
      if (value === null || value === undefined || value === '') return null;
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new PortalHttpError(400, 'VALIDATION_ERROR', `${label} is not a valid date.`);
      return date.toISOString();
    };
    const opensAt = parseDate(body.opens_at, 'Opening time');
    const closesAt = parseDate(body.closes_at, 'Closing time');
    if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Closing time must be after opening time.');
    }

    if (status === 'published') {
      const { data: questions, error: questionError } = await supabase
        .from('test_questions')
        .select('id, answer_type, options')
        .eq('test_id', testId);
      if (questionError) throw questionError;
      if (!questions?.length) throw new PortalHttpError(409, 'TEST_EMPTY', 'Add at least one problem before publishing.');
      const ids = questions.map((question) => question.id);
      const { data: keys, error: keyError } = await supabase
        .from('test_question_keys')
        .select('question_id, numerical_answer, choice_key')
        .in('question_id', ids);
      if (keyError) throw keyError;
      const keyMap = new Map((keys ?? []).map((key) => [key.question_id, key]));
      const missing = questions.find((question) => {
        if (question.answer_type === 'file_upload') return false;
        const key = keyMap.get(question.id);
        return question.answer_type === 'numerical'
          ? key?.numerical_answer === null || key?.numerical_answer === undefined
          : !key?.choice_key || !normalizeQuestionOptions(question.options).some((option) => option.id === key.choice_key);
      });
      if (missing) throw new PortalHttpError(409, 'ANSWER_KEY_MISSING', 'Every automatically graded problem needs a valid answer key.');
    }

    const { data, error } = await supabase.from('tests').update({
      title,
      description,
      instructions_latex: instructions,
      duration_minutes: duration,
      security_mode: securityMode,
      require_fullscreen: body.require_fullscreen === true,
      block_clipboard: body.block_clipboard === true,
      opens_at: opensAt,
      closes_at: closesAt,
      status,
      show_results: body.show_results === true,
    }).eq('id', testId).select('*').maybeSingle();
    if (error) throw error;
    if (!data) throw new PortalHttpError(404, 'TEST_NOT_FOUND', 'That test was not found.');

    // Keep active server deadlines aligned when an administrator changes the
    // duration or closing time. Completed attempts remain immutable.
    const { data: activeAttempts, error: activeError } = await supabase
      .from('test_attempts')
      .select('id, started_at, extension_minutes')
      .eq('test_id', testId)
      .eq('status', 'in_progress');
    if (activeError) throw activeError;
    for (const activeAttempt of activeAttempts ?? []) {
      const expiresAt = calculateAttemptExpiry(
        data as TestRow,
        new Date(activeAttempt.started_at),
        Number(activeAttempt.extension_minutes ?? 0),
      );
      const { error: expiryError } = await supabase
        .from('test_attempts')
        .update({ expires_at: expiresAt.toISOString() })
        .eq('id', activeAttempt.id);
      if (expiryError) throw expiryError;
    }
    await logAdminAudit(supabase, user.id, 'test_settings_updated', { test_id: testId }, {
      previous_status: existingTest.status,
      status: data.status,
      previous_duration_minutes: existingTest.duration_minutes,
      duration_minutes: data.duration_minutes,
      security_mode: data.security_mode,
      opens_at: data.opens_at,
      closes_at: data.closes_at,
      show_results: data.show_results,
    });
    return portalJson({ test: data });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
