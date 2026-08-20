import type { APIRoute } from 'astro';
import { requireSameOrigin } from '../../../../../lib/requestGuards';
import { logAdminAudit } from '../../../../../lib/testPortal';
import {
  authenticatePortalRequest,
  PortalHttpError,
  portalErrorResponse,
  portalJson,
  readPortalJson,
  stringField,
} from '../../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request }) => {
  try {
    const { supabase, user } = await authenticatePortalRequest(request, { admin: true });
    const { data: rows, error } = await supabase
      .from('test_admins')
      .select('user_id, created_at, granted_by, note')
      .order('created_at');
    if (error) throw error;

    const admins = await Promise.all((rows ?? []).map(async (row) => {
      const { data } = await supabase.auth.admin.getUserById(row.user_id);
      return {
        user_id: row.user_id,
        email: data.user?.email ?? 'Unknown account',
        display_name: String(data.user?.user_metadata?.display_name ?? data.user?.user_metadata?.full_name ?? ''),
        created_at: row.created_at,
        granted_by: row.granted_by,
        note: row.note,
        is_self: row.user_id === user.id,
      };
    }));
    const { data: auditRows, error: auditError } = await supabase
      .from('test_admin_audit_log')
      .select('id, admin_user_id, action, metadata, created_at')
      .in('action', ['admin_role_granted', 'admin_role_revoked'])
      .order('created_at', { ascending: false })
      .limit(50);
    if (auditError) throw auditError;
    const actorIds = [...new Set((auditRows ?? []).map((row) => row.admin_user_id).filter(Boolean))] as string[];
    const actorEntries = await Promise.all(actorIds.map(async (id) => {
      const { data } = await supabase.auth.admin.getUserById(id);
      return [id, data.user?.email ?? 'Unknown administrator'] as const;
    }));
    const actors = new Map(actorEntries);
    const audit = (auditRows ?? []).map((row) => ({
      ...row,
      actor_email: row.admin_user_id ? actors.get(row.admin_user_id) ?? 'Unknown administrator' : 'Deleted administrator',
    }));
    return portalJson({ admins, audit });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;
    const { supabase, user } = await authenticatePortalRequest(request, {
      admin: true,
      rateLimit: { limit: 20, windowSeconds: 60, scope: 'admin-role-change' },
    });
    const body = await readPortalJson(request);
    const email = stringField(body.email, 'email', { required: true, max: 320 }).toLowerCase();
    const note = stringField(body.note, 'note', { max: 1000 });
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Enter a valid account email address.');
    }

    let targetUser = null;
    for (let page = 1; page <= 10 && !targetUser; page += 1) {
      const { data, error: listError } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (listError) throw listError;
      targetUser = data.users.find((candidate) => candidate.email?.toLowerCase() === email) ?? null;
      if (data.users.length < 1000) break;
    }
    if (!targetUser) {
      throw new PortalHttpError(
        404,
        'ACCOUNT_NOT_FOUND',
        'No Test Portal account uses that email. Ask the person to create an account first.',
      );
    }

    const { data: existing, error: existingError } = await supabase
      .from('test_admins')
      .select('user_id')
      .eq('user_id', targetUser.id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) throw new PortalHttpError(409, 'ALREADY_ADMIN', 'That account is already an administrator.');

    const { data: created, error: createError } = await supabase
      .from('test_admins')
      .insert({ user_id: targetUser.id, granted_by: user.id, note })
      .select('user_id, created_at, granted_by, note')
      .single();
    if (createError) throw createError;
    await logAdminAudit(supabase, user.id, 'admin_role_granted', {}, {
      target_user_id: targetUser.id,
      target_email: targetUser.email,
      note,
    });
    return portalJson({
      admin: {
        ...created,
        email: targetUser.email ?? email,
        display_name: String(targetUser.user_metadata?.display_name ?? targetUser.user_metadata?.full_name ?? ''),
        is_self: targetUser.id === user.id,
      },
    }, { status: 201 });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
