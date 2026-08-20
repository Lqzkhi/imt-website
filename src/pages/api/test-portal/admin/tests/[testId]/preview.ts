import type { APIRoute } from 'astro';
import { publicQuestion, type QuestionRow } from '../../../../../../lib/testPortal';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson } from '../../../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const { supabase } = await authenticatePortalRequest(request, { admin: true });
    const testId = params.testId ?? '';
    const [{ data: test, error: testError }, { data: questions, error: questionError }] = await Promise.all([
      supabase.from('tests').select('*').eq('id', testId).maybeSingle(),
      supabase.from('test_questions').select('id, test_id, position, title, prompt_latex, answer_type, options, points, file_extensions, max_file_size_mb').eq('test_id', testId).order('position'),
    ]);
    if (testError) throw testError;
    if (questionError) throw questionError;
    if (!test) throw new PortalHttpError(404, 'TEST_NOT_FOUND', 'That test was not found.');
    return portalJson({
      test: {
        id: test.id,
        title: test.title,
        description: test.description,
        instructions_latex: test.instructions_latex,
        duration_minutes: test.duration_minutes,
        security_mode: test.security_mode,
        require_fullscreen: test.require_fullscreen,
        block_clipboard: test.block_clipboard,
        opens_at: test.opens_at,
        closes_at: test.closes_at,
        status: test.status,
      },
      questions: ((questions ?? []) as QuestionRow[]).map(publicQuestion),
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

