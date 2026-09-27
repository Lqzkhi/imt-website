import type { APIRoute } from 'astro';
import { signedResponseFiles, finalizeIfExpired, getOwnedAttempt, publicQuestion, publicResponse, requireAttemptSession, type QuestionRow, type ResponseRow } from '../../../../../lib/testPortal';
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
    const fileLists = new Map(await Promise.all(responseRows.map(async (r) => [r.id, await signedResponseFiles(supabase, r)] as const)));

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
        working_ended_at: attempt.working_ended_at ?? null,
        submitted_at: attempt.submitted_at,
        auto_submitted: attempt.auto_submitted,
        fullscreen_warnings: attempt.fullscreen_warnings ?? 0,
        grading_status: attempt.grading_status,
        ...(showGrade ? {
          score: Number(attempt.score ?? 0),
          auto_score: Number(attempt.auto_score ?? 0),
          max_score: Number(attempt.max_score ?? 0),
        } : {}),
      },
      questions: ((questions ?? []) as QuestionRow[]).map((question) => publicQuestion(
        owned.test.contest_section === 'proof' && attempt.working_ended_at && !showGrade
          ? { ...question, prompt_latex: 'Solving has ended. Upload only work completed during the timed round.' }
          : question,
      )),
      responses: responseRows.map((response) => ({ ...publicResponse(response,showGrade), files: fileLists.get(response.id) ?? [], file_url:fileLists.get(response.id)?.[0]?.file_url ?? null })),
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
