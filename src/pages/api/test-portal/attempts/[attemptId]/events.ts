import type { APIRoute } from 'astro';
import { finalizeIfExpired, getOwnedAttempt, logSecurityEvent, PORTAL_EVENT_TYPES, requireAttemptSession } from '../../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson, readPortalJson, stringField } from '../../../../../lib/testPortalAuth';
import { requireSameOrigin } from '../../../../../lib/requestGuards';

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;

    const { supabase, user } = await authenticatePortalRequest(request);
    const owned = await getOwnedAttempt(supabase, params.attemptId ?? '', user.id);
    const attempt = await finalizeIfExpired(supabase, owned.attempt);
    if (attempt.status !== 'in_progress') {
      throw new PortalHttpError(409, 'ATTEMPT_CLOSED', 'This attempt has ended.');
    }
    requireAttemptSession(request, attempt, owned.test);

    const body = await readPortalJson(request);
    const eventType = stringField(body.event_type, 'event_type', { required: true, max: 80 });
    if (!PORTAL_EVENT_TYPES.has(eventType)) {
      throw new PortalHttpError(400, 'INVALID_EVENT', 'That security event is not recognized.');
    }
    const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : {};
    await logSecurityEvent(supabase, attempt, eventType, metadata);
    await supabase.from('test_attempts').update({ last_seen_at: new Date().toISOString() }).eq('id', attempt.id);
    return portalJson({ recorded: true });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

