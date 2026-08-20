import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createServerClient } from './supabaseServer';

export class PortalHttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'PortalHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface PortalAuthContext {
  supabase: SupabaseClient;
  user: User;
  accessToken: string;
  isAdmin: boolean;
}

export function portalJson(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store, private');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function portalErrorResponse(error: unknown) {
  if (error instanceof PortalHttpError) {
    const headers = error.code === 'RATE_LIMITED' ? { 'Retry-After': '60' } : undefined;
    return portalJson(
      { error: error.message, code: error.code, details: error.details },
      { status: error.status, headers },
    );
  }

  console.error('[test-portal]', error);
  return portalJson(
    { error: 'The test portal could not complete that request.', code: 'INTERNAL_ERROR' },
    { status: 500 },
  );
}

export async function readPortalJson(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new PortalHttpError(415, 'JSON_REQUIRED', 'This endpoint requires a JSON request body.');
  }

  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    throw new PortalHttpError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
}

export async function authenticatePortalRequest(
  request: Request,
  options: {
    admin?: boolean;
    rateLimit?: false | { limit: number; windowSeconds: number; scope?: string };
  } = {},
): Promise<PortalAuthContext> {
  const authorization = request.headers.get('authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match?.[1]) {
    throw new PortalHttpError(401, 'AUTH_REQUIRED', 'Please sign in to use the Test Portal.');
  }

  const accessToken = match[1].trim();
  const supabase = createServerClient();
  const { data, error } = await supabase.auth.getUser(accessToken);

  if (error || !data.user) {
    throw new PortalHttpError(401, 'INVALID_SESSION', 'Your session has expired. Please sign in again.');
  }

  const { data: adminRow, error: adminError } = await supabase
    .from('test_admins')
    .select('user_id')
    .eq('user_id', data.user.id)
    .maybeSingle();

  if (adminError) {
    throw new PortalHttpError(500, 'ADMIN_LOOKUP_FAILED', 'Unable to verify portal permissions.');
  }

  const isAdmin = Boolean(adminRow);
  if (options.admin && !isAdmin) {
    throw new PortalHttpError(403, 'ADMIN_REQUIRED', 'Test Portal administrator access is required.');
  }

  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());
  if (mutation && options.rateLimit !== false) {
    const config = options.rateLimit || { limit: 240, windowSeconds: 60 };
    const scope = config.scope ?? `${request.method.toUpperCase()}:${new URL(request.url).pathname}`;
    const { data: rateLimit, error: rateLimitError } = await supabase
      .rpc('consume_test_portal_rate_limit', {
        p_bucket_key: `${data.user.id}:${scope}`,
        p_limit: config.limit,
        p_window_seconds: config.windowSeconds,
      })
      .single();

    if (rateLimitError) {
      throw new PortalHttpError(500, 'RATE_LIMIT_UNAVAILABLE', 'Unable to verify the request rate limit.');
    }
    const rateLimitResult = rateLimit as { allowed: boolean; reset_at: string } | null;
    if (!rateLimitResult?.allowed) {
      throw new PortalHttpError(
        429,
        'RATE_LIMITED',
        'Too many requests were sent. Wait a moment and try again.',
        { reset_at: rateLimitResult?.reset_at },
      );
    }
  }

  return { supabase, user: data.user, accessToken, isAdmin };
}

export function stringField(
  value: unknown,
  fieldName: string,
  options: { required?: boolean; max?: number } = {},
) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (options.required && !text) {
    throw new PortalHttpError(400, 'VALIDATION_ERROR', `${fieldName} is required.`);
  }
  if (options.max && text.length > options.max) {
    throw new PortalHttpError(400, 'VALIDATION_ERROR', `${fieldName} is too long.`);
  }
  return text;
}

export function uuidField(value: unknown, fieldName: string) {
  const text = stringField(value, fieldName, { required: true });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new PortalHttpError(400, 'VALIDATION_ERROR', `${fieldName} is not a valid identifier.`);
  }
  return text;
}
