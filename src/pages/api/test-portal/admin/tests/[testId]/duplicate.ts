import type { APIRoute } from 'astro';
import { requireSameOrigin } from '../../../../../../lib/requestGuards';
import { logAdminAudit } from '../../../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson } from '../../../../../../lib/testPortalAuth';

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;
    const { supabase, user } = await authenticatePortalRequest(request, { admin: true });
    const testId = params.testId ?? '';
    const [{ data: source, error: sourceError }, { data: questions, error: questionError }] = await Promise.all([
      supabase.from('tests').select('*').eq('id', testId).maybeSingle(),
      supabase.from('test_questions').select('*').eq('test_id', testId).order('position'),
    ]);
    if (sourceError) throw sourceError;
    if (questionError) throw questionError;
    if (!source) throw new PortalHttpError(404, 'TEST_NOT_FOUND', 'That test was not found.');

    const { data: copy, error: copyError } = await supabase.from('tests').insert({
      title: `Copy of ${source.title}`.slice(0, 160),
      description: source.description,
      instructions_latex: source.instructions_latex,
      duration_minutes: source.duration_minutes,
      security_mode: source.security_mode,
      require_fullscreen: source.require_fullscreen,
      block_clipboard: source.block_clipboard,
      opens_at: null,
      closes_at: null,
      status: 'draft',
      show_results: source.show_results,
      created_by: user.id,
    }).select('*').single();
    if (copyError) throw copyError;

    try {
      for (const question of questions ?? []) {
        const { data: key, error: keyReadError } = await supabase
          .from('test_question_keys')
          .select('*')
          .eq('question_id', question.id)
          .maybeSingle();
        if (keyReadError) throw keyReadError;
        const { id: _oldId, test_id: _oldTestId, created_at: _created, updated_at: _updated, ...questionFields } = question;
        const { data: copiedQuestion, error: copiedQuestionError } = await supabase
          .from('test_questions')
          .insert({ ...questionFields, test_id: copy.id })
          .select('id')
          .single();
        if (copiedQuestionError) throw copiedQuestionError;
        if (key) {
          const { question_id: _questionId, created_at: _keyCreated, updated_at: _keyUpdated, ...keyFields } = key;
          const { error: copiedKeyError } = await supabase
            .from('test_question_keys')
            .insert({ ...keyFields, question_id: copiedQuestion.id });
          if (copiedKeyError) throw copiedKeyError;
        }
      }
    } catch (error) {
      await supabase.from('tests').delete().eq('id', copy.id);
      throw error;
    }

    await logAdminAudit(supabase, user.id, 'test_duplicated', { test_id: copy.id }, {
      source_test_id: source.id,
      source_title: source.title,
      question_count: questions?.length ?? 0,
    });

    return portalJson({ test: copy }, { status: 201 });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
