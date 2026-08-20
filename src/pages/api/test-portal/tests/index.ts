import type { APIRoute } from 'astro';
import { getTestAvailability, type AttemptRow, type TestRow } from '../../../../lib/testPortal';
import { authenticatePortalRequest, portalErrorResponse, portalJson } from '../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request }) => {
  try {
    const { supabase, user } = await authenticatePortalRequest(request);
    const [{ data: tests, error: testsError }, { data: attempts, error: attemptsError }] = await Promise.all([
      supabase
        .from('tests')
        .select('*')
        .eq('status', 'published')
        .order('opens_at', { ascending: true, nullsFirst: true })
        .order('created_at', { ascending: false }),
      supabase
        .from('test_attempts')
        .select('*')
        .eq('user_id', user.id),
    ]);
    if (testsError) throw testsError;
    if (attemptsError) throw attemptsError;

    const testRows = (tests ?? []) as TestRow[];
    const attemptRows = (attempts ?? []) as AttemptRow[];
    const testIds = testRows.map((test) => test.id);
    const { data: questionRows, error: questionError } = testIds.length
      ? await supabase.from('test_questions').select('id, test_id').in('test_id', testIds)
      : { data: [], error: null };
    if (questionError) throw questionError;

    const counts = new Map<string, number>();
    for (const question of questionRows ?? []) {
      counts.set(question.test_id, (counts.get(question.test_id) ?? 0) + 1);
    }
    const attemptsByTest = new Map(attemptRows.map((attempt) => [attempt.test_id, attempt]));

    return portalJson({
      tests: testRows.map((test) => {
        const attempt = attemptsByTest.get(test.id);
        return {
          id: test.id,
          title: test.title,
          description: test.description,
          duration_minutes: test.duration_minutes,
          security_mode: test.security_mode,
          require_fullscreen: test.require_fullscreen,
          block_clipboard: test.block_clipboard,
          opens_at: test.opens_at,
          closes_at: test.closes_at,
          availability: getTestAvailability(test),
          question_count: counts.get(test.id) ?? 0,
          attempt: attempt ? {
            id: attempt.id,
            status: attempt.status,
            started_at: attempt.started_at,
            expires_at: attempt.expires_at,
            submitted_at: attempt.submitted_at,
            grading_status: attempt.grading_status,
            ...(test.show_results && attempt.status !== 'in_progress' ? {
              score: Number(attempt.score ?? 0),
              max_score: Number(attempt.max_score ?? 0),
            } : {}),
          } : null,
        };
      }),
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

