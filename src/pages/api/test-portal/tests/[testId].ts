import type { APIRoute } from 'astro';
import { getTestAvailability, type AttemptRow, type TestRow } from '../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson } from '../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const { supabase, user } = await authenticatePortalRequest(request);
    const testId = params.testId ?? '';
    const { data, error } = await supabase
      .from('tests')
      .select('*')
      .eq('id', testId)
      .eq('status', 'published')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new PortalHttpError(404, 'TEST_NOT_FOUND', 'That test is not available.');

    const test = data as TestRow;
    const [{ count, error: countError }, { data: attemptData, error: attemptError }] = await Promise.all([
      supabase.from('test_questions').select('id', { count: 'exact', head: true }).eq('test_id', test.id),
      supabase.from('test_attempts').select('*').eq('test_id', test.id).eq('user_id', user.id).maybeSingle(),
    ]);
    if (countError) throw countError;
    if (attemptError) throw attemptError;

    const attempt = attemptData as AttemptRow | null;
    return portalJson({
      test: {
        id: test.id,
        title: test.title,
        description: test.description,
        instructions_latex: test.instructions_latex,
        duration_minutes: test.duration_minutes,
        security_mode: test.security_mode,
        require_fullscreen: test.require_fullscreen,
        block_clipboard: test.block_clipboard,
        opens_at: test.opens_at,
        closes_at: test.closes_at,
        availability: getTestAvailability(test),
        question_count: count ?? 0,
      },
      attempt: attempt ? {
        id: attempt.id,
        status: attempt.status,
        started_at: attempt.started_at,
        expires_at: attempt.expires_at,
        submitted_at: attempt.submitted_at,
      } : null,
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

