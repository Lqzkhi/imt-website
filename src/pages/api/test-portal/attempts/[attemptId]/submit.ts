import type { APIRoute } from 'astro';
import { finalizeAttempt, finalizeIfExpired, getOwnedAttempt, requireAttemptSession } from '../../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson } from '../../../../../lib/testPortalAuth';
import { requireSameOrigin } from '../../../../../lib/requestGuards';

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;

    const { supabase, user } = await authenticatePortalRequest(request);
    const owned = await getOwnedAttempt(supabase, params.attemptId ?? '', user.id);
    let attempt = await finalizeIfExpired(supabase, owned.attempt);
    if (attempt.status === 'in_progress') {
      requireAttemptSession(request, attempt, owned.test);
      attempt = await finalizeAttempt(supabase, attempt, 'submitted');
    }
    if (attempt.status === 'in_progress') {
      throw new PortalHttpError(409, 'SUBMISSION_FAILED', 'The attempt could not be submitted.');
    }

    return portalJson({
      attempt: {
        id: attempt.id,
        status: attempt.status,
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

