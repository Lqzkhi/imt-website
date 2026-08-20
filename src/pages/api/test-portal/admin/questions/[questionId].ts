import type { APIRoute } from 'astro';
import { requireSameOrigin } from '../../../../../lib/requestGuards';
import { logAdminAudit } from '../../../../../lib/testPortal';
import { ensureTestStructureEditable, validateQuestionInput } from '../../../../../lib/testPortalAdmin';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson, readPortalJson } from '../../../../../lib/testPortalAuth';

async function getQuestionContext(supabase: Awaited<ReturnType<typeof authenticatePortalRequest>>['supabase'], questionId: string) {
  const { data, error } = await supabase.from('test_questions').select('*').eq('id', questionId).maybeSingle();
  if (error) throw error;
  if (!data) throw new PortalHttpError(404, 'QUESTION_NOT_FOUND', 'That problem was not found.');
  return data;
}

export const PATCH: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;
    const context = await authenticatePortalRequest(request, { admin: true });
    const questionId = params.questionId ?? '';
    const existing = await getQuestionContext(context.supabase, questionId);
    await ensureTestStructureEditable(context.supabase, existing.test_id);
    const body = await readPortalJson(request);
    const { question, key } = validateQuestionInput(body);

    const { data: updated, error: updateError } = await context.supabase
      .from('test_questions')
      .update(question)
      .eq('id', questionId)
      .select('*')
      .single();
    if (updateError) throw updateError;
    const { data: updatedKey, error: keyError } = await context.supabase
      .from('test_question_keys')
      .upsert({ ...key, question_id: questionId }, { onConflict: 'question_id' })
      .select('*')
      .single();
    if (keyError) throw keyError;
    await logAdminAudit(context.supabase, context.user.id, 'question_updated', {
      test_id: existing.test_id,
      question_id: questionId,
    }, {
      previous_answer_type: existing.answer_type,
      answer_type: updated.answer_type,
      position: updated.position,
      points: updated.points,
    });
    return portalJson({ question: { ...updated, answer_key: updatedKey } });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;
    const context = await authenticatePortalRequest(request, { admin: true });
    const questionId = params.questionId ?? '';
    const existing = await getQuestionContext(context.supabase, questionId);
    await ensureTestStructureEditable(context.supabase, existing.test_id);
    const [{ data: test, error: testError }, { count: questionCount, error: countError }] = await Promise.all([
      context.supabase.from('tests').select('status').eq('id', existing.test_id).single(),
      context.supabase.from('test_questions').select('id', { count: 'exact', head: true }).eq('test_id', existing.test_id),
    ]);
    if (testError) throw testError;
    if (countError) throw countError;
    if (test.status === 'published' && (questionCount ?? 0) <= 1) {
      throw new PortalHttpError(409, 'PUBLISHED_TEST_EMPTY', 'Move the test to draft before deleting its final problem.');
    }

    const { error } = await context.supabase.from('test_questions').delete().eq('id', questionId);
    if (error) throw error;

    const { data: remaining, error: remainingError } = await context.supabase
      .from('test_questions')
      .select('id')
      .eq('test_id', existing.test_id)
      .order('position');
    if (remainingError) throw remainingError;
    for (let index = 0; index < (remaining ?? []).length; index += 1) {
      await context.supabase.from('test_questions').update({ position: 1000 + index }).eq('id', remaining![index].id);
    }
    for (let index = 0; index < (remaining ?? []).length; index += 1) {
      await context.supabase.from('test_questions').update({ position: index + 1 }).eq('id', remaining![index].id);
    }
    await logAdminAudit(context.supabase, context.user.id, 'question_deleted', {
      test_id: existing.test_id,
    }, {
      deleted_question_id: questionId,
      title: existing.title,
      answer_type: existing.answer_type,
      position: existing.position,
    });
    return portalJson({ deleted: true });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
