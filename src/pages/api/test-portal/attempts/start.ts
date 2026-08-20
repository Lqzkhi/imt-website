import type { APIRoute } from 'astro';
import { calculateAttemptExpiry, finalizeIfExpired, getTestAvailability, hashPortalSession, logSecurityEvent, requireAttemptSession, type AttemptRow, type TestRow } from '../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson, readPortalJson, uuidField } from '../../../../lib/testPortalAuth';
import { requireSameOrigin } from '../../../../lib/requestGuards';

export const POST: APIRoute = async ({ request }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;

    const { supabase, user } = await authenticatePortalRequest(request, {
      rateLimit: { limit: 20, windowSeconds: 60, scope: 'attempt-start' },
    });
    const body = await readPortalJson(request);
    const testId = uuidField(body.test_id, 'test_id');
    const sessionToken = typeof body.session_token === 'string' ? body.session_token.trim() : '';

    const { data: testData, error: testError } = await supabase
      .from('tests')
      .select('*')
      .eq('id', testId)
      .maybeSingle();
    if (testError) throw testError;
    if (!testData) throw new PortalHttpError(404, 'TEST_NOT_FOUND', 'That test was not found.');

    const test = testData as TestRow;
    const { data: existingData, error: existingError } = await supabase
      .from('test_attempts')
      .select('*')
      .eq('test_id', test.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (existingError) throw existingError;

    if (existingData) {
      let existing = await finalizeIfExpired(supabase, existingData as AttemptRow);
      if (existing.status === 'in_progress' && test.security_mode === 'one_sitting' && !existing.security_session_hash) {
        if (sessionToken.length < 20 || sessionToken.length > 200) {
          throw new PortalHttpError(400, 'SESSION_TOKEN_REQUIRED', 'A secure browser session could not be established.');
        }
        const { data: rebound, error: reboundError } = await supabase
          .from('test_attempts')
          .update({ security_session_hash: hashPortalSession(sessionToken) })
          .eq('id', existing.id)
          .select('*')
          .single();
        if (reboundError) throw reboundError;
        existing = rebound as AttemptRow;
      }

      requireAttemptSession(request, existing, test);
      if (existing.status === 'in_progress') {
        await logSecurityEvent(supabase, existing, 'attempt_resumed');
      }
      return portalJson({ attempt: { id: existing.id, status: existing.status } });
    }

    if (getTestAvailability(test) !== 'open') {
      throw new PortalHttpError(409, 'TEST_NOT_OPEN', 'This test is not currently open for attempts.');
    }
    if (test.security_mode === 'one_sitting' && (sessionToken.length < 20 || sessionToken.length > 200)) {
      throw new PortalHttpError(400, 'SESSION_TOKEN_REQUIRED', 'A secure browser session could not be established.');
    }

    const { data: questions, error: questionError } = await supabase
      .from('test_questions')
      .select('id, points')
      .eq('test_id', test.id);
    if (questionError) throw questionError;
    if (!questions?.length) {
      throw new PortalHttpError(409, 'TEST_EMPTY', 'This test does not have any problems yet.');
    }

    const now = new Date();
    const expiresAt = calculateAttemptExpiry(test, now);
    const metadata = user.user_metadata ?? {};
    const participantName = String(metadata.display_name ?? metadata.full_name ?? metadata.team_name ?? '').slice(0, 160);
    const payload = {
      test_id: test.id,
      user_id: user.id,
      participant_email: user.email ?? '',
      participant_name: participantName,
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      security_session_hash: test.security_mode === 'one_sitting' ? hashPortalSession(sessionToken) : null,
      max_score: questions.reduce((sum, question) => sum + Number(question.points), 0),
    };

    const { data: created, error: createError } = await supabase
      .from('test_attempts')
      .insert(payload)
      .select('*')
      .single();
    if (createError) {
      if (createError.code === '23505') {
        throw new PortalHttpError(409, 'ATTEMPT_EXISTS', 'An attempt already exists. Refresh the Test Portal to continue it.');
      }
      throw createError;
    }

    await logSecurityEvent(supabase, created as AttemptRow, 'attempt_started', {
      security_mode: test.security_mode,
      duration_minutes: test.duration_minutes,
    });

    return portalJson({ attempt: { id: created.id, status: created.status } }, { status: 201 });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
