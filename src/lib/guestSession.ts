import { randomUUID } from 'node:crypto';
import type { AstroCookies } from 'astro';

const COOKIE_NAME = 'im_uid';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export async function getUserProfileFromCookie(supabase: any, cookies: AstroCookies) {
  const externalId = cookies.get(COOKIE_NAME)?.value;
  if (!externalId) return null;

  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('external_id', externalId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function getOrCreateUserProfile(supabase: any, cookies: AstroCookies) {
  const existing = await getUserProfileFromCookie(supabase, cookies);
  if (existing) return existing;

  const externalId = randomUUID();

  cookies.set(COOKIE_NAME, externalId, {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });

  const { data, error } = await supabase
    .from('user_profiles')
    .insert({ external_id: externalId, last_active_at: new Date().toISOString() })
    .select()
    .single();

  if (error) throw error;
  return data;
}
