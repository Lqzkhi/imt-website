import type { APIRoute } from 'astro';
import { authenticatePortalRequest, portalErrorResponse, portalJson } from '../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request }) => {
  try {
    const { supabase } = await authenticatePortalRequest(request, { admin: true });
    const { data: events, error } = await supabase
      .from('test_admin_audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(250);
    if (error) throw error;

    const rows = events ?? [];
    const actorIds = [...new Set(rows.map((event) => event.admin_user_id).filter(Boolean))] as string[];
    const testIds = [...new Set(rows.map((event) => event.test_id).filter(Boolean))] as string[];
    const attemptIds = [...new Set(rows.map((event) => event.attempt_id).filter(Boolean))] as string[];
    const [actors, testsResult, attemptsResult] = await Promise.all([
      Promise.all(actorIds.map(async (id) => {
        const { data } = await supabase.auth.admin.getUserById(id);
        return [id, data.user?.email ?? 'Unknown administrator'] as const;
      })),
      testIds.length
        ? supabase.from('tests').select('id, title').in('id', testIds)
        : Promise.resolve({ data: [], error: null }),
      attemptIds.length
        ? supabase.from('test_attempts').select('id, participant_email, participant_name').in('id', attemptIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (testsResult.error) throw testsResult.error;
    if (attemptsResult.error) throw attemptsResult.error;

    const actorMap = new Map(actors);
    const testMap = new Map((testsResult.data ?? []).map((test) => [test.id, test.title]));
    const attemptMap = new Map((attemptsResult.data ?? []).map((attempt) => [attempt.id, {
      email: attempt.participant_email,
      name: attempt.participant_name,
    }]));

    return portalJson({
      events: rows.map((event) => ({
        ...event,
        actor_email: event.admin_user_id ? actorMap.get(event.admin_user_id) ?? 'Unknown administrator' : 'Removed administrator',
        test_title: event.test_id ? testMap.get(event.test_id) ?? null : null,
        participant: event.attempt_id ? attemptMap.get(event.attempt_id) ?? null : null,
      })),
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
