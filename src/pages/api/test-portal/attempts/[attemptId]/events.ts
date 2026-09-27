import type { APIRoute } from 'astro';
import { finalizeIfExpired, getOwnedAttempt, logSecurityEvent, PORTAL_EVENT_TYPES, requireAttemptSession } from '../../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson, readPortalJson, stringField, uuidField } from '../../../../../lib/testPortalAuth';
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
    if (eventType === 'fullscreen_exited') {
      const eventId = metadata.event_id ? uuidField(metadata.event_id, 'event_id') : crypto.randomUUID();
      const { data, error } = await supabase.rpc('record_fullscreen_exit', { p_attempt_id: attempt.id, p_event_id: eventId });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.id) throw new Error('Fullscreen event did not return an attempt.');
      return portalJson({ recorded: true, fullscreen_warnings: row.fullscreen_warnings, locked: Boolean(row.security_locked_at) });
    }
    await logSecurityEvent(supabase, attempt, eventType, { ...metadata, phase: attempt.working_ended_at ? 'upload' : 'solving' });
    await supabase.from('test_attempts').update({ last_seen_at: new Date().toISOString() }).eq('id', attempt.id);
    return portalJson({ recorded: true });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

