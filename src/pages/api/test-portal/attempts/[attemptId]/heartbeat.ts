import type { APIRoute } from 'astro';
import { finalizeIfExpired, getOwnedAttempt, requireAttemptSession } from '../../../../../lib/testPortal';
import { authenticatePortalRequest, portalErrorResponse, portalJson } from '../../../../../lib/testPortalAuth';
import { requireSameOrigin } from '../../../../../lib/requestGuards';

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;
    const { supabase, user } = await authenticatePortalRequest(request);
    const owned = await getOwnedAttempt(supabase, params.attemptId ?? '', user.id);
    const attempt = await finalizeIfExpired(supabase, owned.attempt);
    requireAttemptSession(request, attempt, owned.test);
    if (attempt.status === 'in_progress') {
      await supabase.from('test_attempts').update({ last_seen_at: new Date().toISOString() }).eq('id', attempt.id);
    }
    return portalJson({
      server_now: new Date().toISOString(),
      status: attempt.status,
      expires_at: attempt.expires_at,
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

