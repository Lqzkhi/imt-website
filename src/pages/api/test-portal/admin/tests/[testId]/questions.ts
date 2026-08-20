import type { APIRoute } from 'astro';
import { requireSameOrigin } from '../../../../../../lib/requestGuards';
import { logAdminAudit } from '../../../../../../lib/testPortal';
import { ensureTestStructureEditable, validateQuestionInput } from '../../../../../../lib/testPortalAdmin';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson, readPortalJson } from '../../../../../../lib/testPortalAuth';

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;
    const { supabase, user } = await authenticatePortalRequest(request, { admin: true });
    const testId = params.testId ?? '';
    const { data: test, error: testError } = await supabase.from('tests').select('id').eq('id', testId).maybeSingle();
    if (testError) throw testError;
    if (!test) throw new PortalHttpError(404, 'TEST_NOT_FOUND', 'That test was not found.');
    await ensureTestStructureEditable(supabase, testId);

    const body = await readPortalJson(request);
    const { question, key } = validateQuestionInput(body);
    const { data: existing, error: positionError } = await supabase
      .from('test_questions')
      .select('position')
      .eq('test_id', testId)
      .order('position', { ascending: false })
      .limit(1);
    if (positionError) throw positionError;
    const position = (existing?.[0]?.position ?? 0) + 1;

    const { data: created, error: createError } = await supabase
      .from('test_questions')
      .insert({ ...question, test_id: testId, position })
      .select('*')
      .single();
    if (createError) throw createError;

    const { data: createdKey, error: keyError } = await supabase
      .from('test_question_keys')
      .insert({ ...key, question_id: created.id })
      .select('*')
      .single();
    if (keyError) {
      await supabase.from('test_questions').delete().eq('id', created.id);
      throw keyError;
    }

    await logAdminAudit(supabase, user.id, 'question_created', {
      test_id: testId,
      question_id: created.id,
    }, { answer_type: created.answer_type, position: created.position, points: created.points });

    return portalJson({ question: { ...created, answer_key: createdKey } }, { status: 201 });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
