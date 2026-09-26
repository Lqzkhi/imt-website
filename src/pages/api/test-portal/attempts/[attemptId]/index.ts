import type { APIRoute } from 'astro';
import { finalizeIfExpired, getOwnedAttempt, publicQuestion, publicResponse, requireAttemptSession, type QuestionRow, type ResponseRow, TEST_SUBMISSIONS_BUCKET } from '../../../../../lib/testPortal';
import { authenticatePortalRequest, portalErrorResponse, portalJson } from '../../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const { supabase, user } = await authenticatePortalRequest(request);
    const owned = await getOwnedAttempt(supabase, params.attemptId ?? '', user.id);
    const attempt = await finalizeIfExpired(supabase, owned.attempt);
    requireAttemptSession(request, attempt, owned.test);

    const [{ data: questions, error: questionError }, { data: responses, error: responseError }] = await Promise.all([
      supabase.from('test_questions').select('id, test_id, position, title, prompt_latex, answer_type, options, points, file_extensions, max_file_size_mb').eq('test_id', owned.test.id).order('position'),
      supabase.from('test_responses').select('*').eq('attempt_id', attempt.id),
    ]);
    if (questionError) throw questionError;
    if (responseError) throw responseError;

    const responseRows = (responses ?? []) as ResponseRow[];
    const fileUrls = new Map<string,string>();
    await Promise.all(responseRows.filter((r) => r.file_path).map(async (r) => {
      const { data, error } = await supabase.storage.from(TEST_SUBMISSIONS_BUCKET).createSignedUrl(r.file_path!,600,{download:r.file_name ?? 'submission'});
      if (error) throw error;
      fileUrls.set(r.id,data.signedUrl);
    }));
    const showGrade = attempt.status !== 'in_progress' && owned.test.show_results;
    return portalJson({
      server_now: new Date().toISOString(),
      test: {
        id: owned.test.id,
        title: owned.test.title,
        contest_section: owned.test.contest_section,
        description: owned.test.description,
        instructions_latex: owned.test.instructions_latex,
        duration_minutes: owned.test.duration_minutes,
        security_mode: owned.test.security_mode,
        require_fullscreen: owned.test.require_fullscreen,
        block_clipboard: owned.test.block_clipboard,
        show_results: owned.test.show_results,
      },
      attempt: {
        id: attempt.id,
        status: attempt.status,
        started_at: attempt.started_at,
        expires_at: attempt.expires_at,
        submitted_at: attempt.submitted_at,
        auto_submitted: attempt.auto_submitted,
        grading_status: attempt.grading_status,
        ...(showGrade ? {
          score: Number(attempt.score ?? 0),
          auto_score: Number(attempt.auto_score ?? 0),
          max_score: Number(attempt.max_score ?? 0),
        } : {}),
      },
      questions: ((questions ?? []) as QuestionRow[]).map(publicQuestion),
      responses: responseRows.map((response) => ({ ...publicResponse(response,showGrade), file_url:fileUrls.get(response.id) ?? null })),
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

