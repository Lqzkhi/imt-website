import type { APIRoute } from 'astro';
import { finalizeIfExpired, type AttemptRow } from '../../../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson } from '../../../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const { supabase } = await authenticatePortalRequest(request, { admin: true });
    const testId = params.testId ?? '';
    const { data: test, error: testError } = await supabase.from('tests').select('*').eq('id', testId).maybeSingle();
    if (testError) throw testError;
    if (!test) throw new PortalHttpError(404, 'TEST_NOT_FOUND', 'That test was not found.');

    const { data: attemptData, error: attemptError } = await supabase
      .from('test_attempts')
      .select('*')
      .eq('test_id', testId)
      .order('started_at', { ascending: false });
    if (attemptError) throw attemptError;
    const attempts = await Promise.all(
      ((attemptData ?? []) as AttemptRow[]).map((attempt) => finalizeIfExpired(supabase, attempt)),
    );
    const ids = attempts.map((attempt) => attempt.id);
    const [{ data: responses, error: responseError }, { data: events, error: eventError }] = ids.length
      ? await Promise.all([
          supabase.from('test_responses').select('attempt_id, question_id').in('attempt_id', ids),
          supabase.from('test_security_events').select('attempt_id, event_type').in('attempt_id', ids),
        ])
      : [{ data: [], error: null }, { data: [], error: null }];
    if (responseError) throw responseError;
    if (eventError) throw eventError;

    const responseCounts = new Map<string, number>();
    for (const response of responses ?? []) {
      responseCounts.set(response.attempt_id, (responseCounts.get(response.attempt_id) ?? 0) + 1);
    }
    const eventCounts = new Map<string, Record<string, number>>();
    for (const event of events ?? []) {
      const counts = eventCounts.get(event.attempt_id) ?? {};
      counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
      eventCounts.set(event.attempt_id, counts);
    }

    return portalJson({
      test,
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        participant_email: attempt.participant_email,
        participant_name: attempt.participant_name,
        status: attempt.status,
        started_at: attempt.started_at,
        expires_at: attempt.expires_at,
        submitted_at: attempt.submitted_at,
        last_seen_at: attempt.last_seen_at,
        auto_submitted: attempt.auto_submitted,
        score: attempt.score === null ? null : Number(attempt.score),
        auto_score: attempt.auto_score === null ? null : Number(attempt.auto_score),
        max_score: Number(attempt.max_score),
        grading_status: attempt.grading_status,
        response_count: responseCounts.get(attempt.id) ?? 0,
        security_events: eventCounts.get(attempt.id) ?? {},
      })),
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

