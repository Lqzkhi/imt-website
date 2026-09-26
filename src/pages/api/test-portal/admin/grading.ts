import type { APIRoute } from 'astro';
import { authenticatePortalRequest, portalErrorResponse, portalJson } from '../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request }) => {
  try {
    const { supabase } = await authenticatePortalRequest(request, { admin: true });
    const { data: test, error } = await supabase.from('tests').select('id,title').eq('contest_section','proof').maybeSingle();
    if (error) throw error;
    if (!test) return portalJson({ test: null, queue: [] });
    const queue = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await supabase.from('test_responses')
        .select('id,attempt_id,question_id,grading_status,points_awarded,graded_at,test_attempts!inner(test_id,status),test_questions!inner(position)')
        .eq('test_attempts.test_id',test.id).neq('test_attempts.status','in_progress').order('id').range(offset,offset+499);
      if (error) throw error;
      queue.push(...(data ?? [])); if ((data?.length ?? 0) < 500) break;
    }
    return portalJson({ test, queue });
  } catch (error) { return portalErrorResponse(error); }
};
