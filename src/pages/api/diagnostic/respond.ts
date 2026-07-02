import type { APIRoute } from 'astro';
import { finalizeSession, getOwnedDiagnosticSession, gradeResponse, selectNextItem } from '../../../lib/catEngine';
import { getUserProfileFromCookie } from '../../../lib/guestSession';
import { requireSameOrigin } from '../../../lib/requestGuards';
import { createServerClient } from '../../../lib/supabaseServer';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const blocked = requireSameOrigin(request);
  if (blocked) return blocked;

  const supabase = createServerClient();
  const formData = await request.formData();
  const sessionId = String(formData.get('session_id') ?? '');
  const submittedItemId = String(formData.get('item_id') ?? '');
  const responseValue = String(formData.get('response_value') ?? '');
  const profile = await getUserProfileFromCookie(supabase, cookies);

  if (!profile || !sessionId || !submittedItemId) {
    return redirect('/learn/diagnostic', 303);
  }

  const session = await getOwnedDiagnosticSession(supabase, sessionId, profile.id);
  if (!session || session.completed_at) {
    return redirect('/learn/diagnostic', 303);
  }

  if (session.current_item_id !== submittedItemId) {
    return redirect(`/learn/diagnostic/session/${sessionId}`, 303);
  }

  const { data: item, error: itemError } = await supabase
    .from('item_bank')
    .select('id, answer, item_format, domain')
    .eq('id', submittedItemId)
    .single();

  if (itemError || !item) {
    return redirect(`/learn/diagnostic/session/${sessionId}`, 303);
  }

  const isCorrect = gradeResponse(item, responseValue);
  const startedAt = session.current_item_started_at ? new Date(session.current_item_started_at).getTime() : Date.now();
  const responseTimeMs = Math.max(0, Date.now() - startedAt);

  const { error: responseError } = await supabase.from('item_responses').insert({
    user_id: session.user_id,
    item_id: item.id,
    session_id: sessionId,
    response_value: responseValue,
    is_correct: isCorrect,
    response_time_ms: responseTimeMs,
    response_mode: 'diagnostic',
    domain: item.domain,
  });

  if (responseError && responseError.code !== '23505') {
    return new Response('Failed to save response.', { status: 500 });
  }

  const result = await selectNextItem(supabase, sessionId);

  if (result.stop) {
    await finalizeSession(supabase, sessionId, result.stopReason ?? 'unknown');
    return redirect(`/learn/diagnostic/report/${sessionId}`, 303);
  }

  await supabase
    .from('sessions')
    .update({
      current_item_id: result.nextItem.id,
      current_item_started_at: new Date().toISOString(),
    })
    .eq('id', sessionId);

  return redirect(`/learn/diagnostic/session/${sessionId}`, 303);
};
