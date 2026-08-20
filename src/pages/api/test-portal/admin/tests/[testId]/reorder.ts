import type { APIRoute } from 'astro';
import { requireSameOrigin } from '../../../../../../lib/requestGuards';
import { logAdminAudit } from '../../../../../../lib/testPortal';
import { ensureTestStructureEditable } from '../../../../../../lib/testPortalAdmin';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson, readPortalJson } from '../../../../../../lib/testPortalAuth';

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;
    const { supabase, user } = await authenticatePortalRequest(request, { admin: true });
    const testId = params.testId ?? '';
    await ensureTestStructureEditable(supabase, testId);
    const body = await readPortalJson(request);
    const ids = Array.isArray(body.question_ids) ? body.question_ids.map(String) : [];
    const { data: questions, error } = await supabase.from('test_questions').select('id').eq('test_id', testId);
    if (error) throw error;
    const existingIds = new Set((questions ?? []).map((question) => question.id));
    if (ids.length !== existingIds.size || new Set(ids).size !== ids.length || ids.some((id) => !existingIds.has(id))) {
      throw new PortalHttpError(400, 'INVALID_ORDER', 'The problem order is incomplete or invalid.');
    }

    for (let index = 0; index < ids.length; index += 1) {
      const { error: temporaryError } = await supabase.from('test_questions').update({ position: 1000 + index }).eq('id', ids[index]);
      if (temporaryError) throw temporaryError;
    }
    for (let index = 0; index < ids.length; index += 1) {
      const { error: finalError } = await supabase.from('test_questions').update({ position: index + 1 }).eq('id', ids[index]);
      if (finalError) throw finalError;
    }
    await logAdminAudit(supabase, user.id, 'questions_reordered', { test_id: testId }, { question_ids: ids });
    return portalJson({ reordered: true });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
