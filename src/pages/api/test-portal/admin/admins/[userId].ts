import type { APIRoute } from 'astro';
import { requireSameOrigin } from '../../../../../lib/requestGuards';
import { logAdminAudit } from '../../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson } from '../../../../../lib/testPortalAuth';

export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;
    const { supabase, user } = await authenticatePortalRequest(request, {
      admin: true,
      rateLimit: { limit: 20, windowSeconds: 60, scope: 'admin-role-change' },
    });
    const targetUserId = params.userId ?? '';
    if (targetUserId === user.id) {
      throw new PortalHttpError(409, 'CANNOT_REMOVE_SELF', 'You cannot remove your own administrator access.');
    }
    const { data: target, error: targetError } = await supabase.auth.admin.getUserById(targetUserId);
    if (targetError) throw targetError;
    const { data: removed, error: removeError } = await supabase.rpc('revoke_test_portal_admin', {
      p_target_user_id: targetUserId,
      p_actor_user_id: user.id,
    });
    if (removeError) {
      if (removeError.message.includes('final Test Portal administrator')) {
        throw new PortalHttpError(409, 'LAST_ADMIN', 'The final administrator cannot be removed.');
      }
      throw removeError;
    }
    if (removed !== true) throw new PortalHttpError(404, 'ADMIN_NOT_FOUND', 'That administrator was not found.');

    await logAdminAudit(supabase, user.id, 'admin_role_revoked', {}, {
      target_user_id: targetUserId,
      target_email: target.user?.email ?? '',
    });
    return portalJson({ removed: true });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
