import type { APIRoute } from 'astro';
import { authenticatePortalRequest, portalErrorResponse, portalJson } from '../../../../lib/testPortalAuth';

export const GET: APIRoute = async ({ request }) => {
  try {
    const { supabase } = await authenticatePortalRequest(request, { admin: true });
    const { data: tests, error: testError } = await supabase.from('tests').select('id,title,contest_section,status,closes_at,require_fullscreen,block_clipboard,show_results').not('contest_section','is',null);
    if (testError) throw testError;
    const ids = (tests ?? []).map((t) => t.id);
    const attempts: Record<string, any>[] = [];
    if (ids.length) for (let offset = 0; ; offset += 500) {
      const { data, error } = await supabase.from('test_attempts').select('id,test_id,user_id,participant_name,participant_email,status,expires_at,last_seen_at,score,max_score,grading_status,disqualified_at').in('test_id',ids).order('id').range(offset,offset+499);
      if (error) throw error;
      attempts.push(...(data ?? [])); if ((data?.length ?? 0) < 500) break;
    }
    const events = new Map<string, Record<string, number>>();
    // Batch both IDs and rows to avoid PostgREST's default row limit.
    for (let start = 0; start < attempts.length; start += 100) {
      const batch = attempts.slice(start,start+100).map((a) => a.id);
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase.from('test_security_events').select('id,attempt_id,event_type,metadata').in('attempt_id',batch).order('id').range(offset,offset+499);
        if (error) throw error;
        for (const event of data ?? []) {
          // Switching tabs to scan or upload completed proofs is permitted.
          // Full events remain available in the individual attempt review.
          if (event.metadata?.phase === 'upload') continue;
          const counts = events.get(event.attempt_id) ?? {};
          counts[event.event_type] = (counts[event.event_type] ?? 0)+1; events.set(event.attempt_id,counts);
        }
        if ((data?.length ?? 0) < 500) break;
      }
    }
    const { data: health, error: healthError } = await supabase.from('test_portal_job_health').select('*').eq('name','auto_submit').maybeSingle();
    if (healthError) throw healthError;
    const users = new Map<string, any>();
    const attentionTypes = ['visibility_hidden','window_blurred','fullscreen_exited','copy_blocked','paste_blocked','fullscreen_unsupported','session_unlocked_by_admin'];
    for (const attempt of attempts) {
      const section = tests?.find((t) => t.id === attempt.test_id)?.contest_section;
      const counts = events.get(attempt.id) ?? {};
      const row = users.get(attempt.user_id) ?? { user_id: attempt.user_id, name: attempt.participant_name, email: attempt.participant_email, sections: {}, review_events: 0 };
      row.sections[section] = { ...attempt, events: counts };
      row.review_events += attentionTypes.reduce((sum,type) => sum+(counts[type] ?? 0),0);
      users.set(attempt.user_id,row);
    }
    const participants = [...users.values()].map((row) => {
      const c = row.sections.computational; const p = row.sections.proof;
      const complete = c && p && !c.disqualified_at && !p.disqualified_at && c.status !== 'in_progress' && p.status !== 'in_progress' && c.grading_status === 'complete' && p.grading_status === 'complete' && Number(c.max_score) > 0 && Number(p.max_score) > 0;
      return { ...row, combined_percent: complete ? 50*Number(c.score)/Number(c.max_score)+50*Number(p.score)/Number(p.max_score) : null };
    }).sort((a,b) => b.review_events-a.review_events || a.email.localeCompare(b.email));
    return portalJson({ tests, participants, health, scheduler_healthy: Boolean(health?.last_run_at && Date.now()-new Date(health.last_run_at).getTime() < 180000),
      overdue_attempts: attempts.filter((a) => a.status === 'in_progress' && new Date(a.expires_at).getTime() <= Date.now()).length });
  } catch (error) { return portalErrorResponse(error); }
};
