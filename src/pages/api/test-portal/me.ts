import type { APIRoute } from 'astro';
import { authenticatePortalRequest, portalErrorResponse, portalJson } from '../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request }) => {
  try {
    const { user, isAdmin } = await authenticatePortalRequest(request);
    const metadata = user.user_metadata ?? {};
    return portalJson({
      user: {
        id: user.id,
        email: user.email ?? '',
        display_name: metadata.display_name ?? metadata.full_name ?? metadata.team_name ?? '',
      },
      is_admin: isAdmin,
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

