import type { APIRoute } from 'astro';
import { finalizeAttempt, finalizeIfExpired, getOwnedAttempt, requireAttemptSession } from '../../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson, readPortalJson } from '../../../../../lib/testPortalAuth';
import { requireSameOrigin } from '../../../../../lib/requestGuards';

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;

    const { supabase, user } = await authenticatePortalRequest(request);
    const body = request.body ? await readPortalJson(request) : {};
    const owned = await getOwnedAttempt(supabase, params.attemptId ?? '', user.id);
    let attempt = await finalizeIfExpired(supabase, owned.attempt);
    // Expiry may have just opened the proof upload phase; do not immediately close it.
    const justEnteredUpload = !owned.attempt.working_ended_at && Boolean(attempt.working_ended_at);
    const endingWorkRetry = body.end_work === true && Boolean(attempt.working_ended_at);
    if (attempt.status === 'in_progress' && !justEnteredUpload && !endingWorkRetry) {
      requireAttemptSession(request, attempt, owned.test);
      attempt = await finalizeAttempt(supabase, attempt, 'submitted');
    }
    if (attempt.status === 'in_progress' && !attempt.working_ended_at) {
      throw new PortalHttpError(409, 'SUBMISSION_FAILED', 'The attempt could not be submitted.');
    }

    return portalJson({
      attempt: {
        id: attempt.id,
        status: attempt.status,
        working_ended_at: attempt.working_ended_at ?? null,
        expires_at: attempt.expires_at,
        submitted_at: attempt.submitted_at,
        grading_status: attempt.grading_status,
        ...(owned.test.show_results ? {
          score: Number(attempt.score ?? 0),
          max_score: Number(attempt.max_score ?? 0),
        } : {}),
      },
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

