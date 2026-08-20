import { supabase } from './supabase.js';
import renderMathInElement from 'katex/contrib/auto-render';

export class PortalClientError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'PortalClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function getPortalSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function portalFetch<T = Record<string, unknown>>(
  path: string,
  options: RequestInit = {},
  sessionToken = '',
): Promise<T> {
  const session = await getPortalSession();
  if (!session?.access_token) {
    throw new PortalClientError(401, 'AUTH_REQUIRED', 'Please sign in to continue.');
  }

  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${session.access_token}`);
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (sessionToken) headers.set('X-Test-Session', sessionToken);

  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new PortalClientError(
      response.status,
      typeof payload.code === 'string' ? payload.code : 'REQUEST_FAILED',
      typeof payload.error === 'string' ? payload.error : 'The request could not be completed.',
      payload.details,
    );
  }
  return payload as T;
}

export function newTestSessionToken() {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

export function attemptSessionStorageKey(attemptId: string) {
  return `imt_test_session_${attemptId}`;
}

export function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatPortalDate(value: string | null | undefined) {
  if (!value) return 'No limit';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatPortalDuration(minutes: number) {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (minutes < 1440 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (minutes >= 1440 && minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h ${remainder}m`;
}

export function renderPortalMath(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('.portal-math:not([data-math-rendered])').forEach((element) => {
    element.dataset.mathRendered = 'true';
    renderMathInElement(element, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
      ],
      throwOnError: false,
      strict: false,
    });
  });
}

export { supabase };
