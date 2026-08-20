import type { APIRoute } from 'astro';
import { requireSameOrigin } from '../../../../../lib/requestGuards';
import { logAdminAudit } from '../../../../../lib/testPortal';
import { authenticatePortalRequest, portalErrorResponse, portalJson, readPortalJson, stringField } from '../../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request }) => {
  try {
    const { supabase } = await authenticatePortalRequest(request, { admin: true });
    const [{ data: tests, error: testsError }, { data: questions, error: questionsError }, { data: attempts, error: attemptsError }] = await Promise.all([
      supabase.from('tests').select('*').order('updated_at', { ascending: false }),
      supabase.from('test_questions').select('id, test_id'),
      supabase.from('test_attempts').select('id, test_id, status'),
    ]);
    if (testsError) throw testsError;
    if (questionsError) throw questionsError;
    if (attemptsError) throw attemptsError;

    const questionCounts = new Map<string, number>();
    for (const question of questions ?? []) {
      questionCounts.set(question.test_id, (questionCounts.get(question.test_id) ?? 0) + 1);
    }
    const attemptCounts = new Map<string, { total: number; submitted: number }>();
    for (const attempt of attempts ?? []) {
      const current = attemptCounts.get(attempt.test_id) ?? { total: 0, submitted: 0 };
      current.total += 1;
      if (attempt.status !== 'in_progress') current.submitted += 1;
      attemptCounts.set(attempt.test_id, current);
    }

    return portalJson({
      tests: (tests ?? []).map((test) => ({
        ...test,
        question_count: questionCounts.get(test.id) ?? 0,
        attempt_count: attemptCounts.get(test.id)?.total ?? 0,
        submitted_count: attemptCounts.get(test.id)?.submitted ?? 0,
      })),
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;
    const { supabase, user } = await authenticatePortalRequest(request, { admin: true });
    const body = await readPortalJson(request);
    const title = stringField(body.title, 'title', { required: true, max: 160 });

    const { data, error } = await supabase.from('tests').insert({
      title,
      description: '',
      instructions_latex: '',
      duration_minutes: 60,
      security_mode: 'one_sitting',
      require_fullscreen: false,
      block_clipboard: false,
      status: 'draft',
      show_results: false,
      created_by: user.id,
    }).select('*').single();
    if (error) throw error;
    await logAdminAudit(supabase, user.id, 'test_created', { test_id: data.id }, { title: data.title });
    return portalJson({ test: data }, { status: 201 });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
