import type { APIRoute } from 'astro';
import { selectNextItem } from '../../../lib/catEngine';
import { getOrCreateUserProfile } from '../../../lib/guestSession';
import { requireSameOrigin } from '../../../lib/requestGuards';
import { createServerClient } from '../../../lib/supabaseServer';

const PRIOR_MAP: Record<string, { mean: number; sd: number }> = {
  none: { mean: -0.5, sd: 1.8 },
  amc8: { mean: -1.2, sd: 1.2 },
  amc10: { mean: 0.0, sd: 1.2 },
  amc12: { mean: 0.3, sd: 1.2 },
  aime: { mean: 1.0, sd: 1.0 },
  higher: { mean: 2.0, sd: 1.0 },
};

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const blocked = requireSameOrigin(request);
  if (blocked) return blocked;

  const supabase = createServerClient();
  const formData = await request.formData();
  const priorLevel = String(formData.get('prior_level') ?? 'none');
  const prior = PRIOR_MAP[priorLevel] ?? PRIOR_MAP.none;
  const profile = await getOrCreateUserProfile(supabase, cookies);

  const { data: session, error } = await supabase
    .from('sessions')
    .insert({
      user_id: profile.id,
      session_type: 'diagnostic',
      theta_start: prior.mean,
      prior_mean: prior.mean,
      prior_sd: prior.sd,
    })
    .select()
    .single();

  if (error || !session) {
    return new Response('Failed to start diagnostic session.', { status: 500 });
  }

  const result = await selectNextItem(supabase, session.id);
  if (result.stop || !result.nextItem) {
    await supabase
      .from('sessions')
      .update({
        completed_at: new Date().toISOString(),
        stop_reason: result.stopReason ?? 'item_pool_exhausted',
      })
      .eq('id', session.id);

    return new Response('No eligible diagnostic items are available yet.', { status: 500 });
  }

  await supabase
    .from('sessions')
    .update({
      current_item_id: result.nextItem.id,
      current_item_started_at: new Date().toISOString(),
    })
    .eq('id', session.id);

  return redirect(`/learn/diagnostic/session/${session.id}`, 303);
};
