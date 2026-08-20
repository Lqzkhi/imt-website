import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PortalHttpError } from './testPortalAuth';

export const TEST_SUBMISSIONS_BUCKET = 'test-submissions';
export const PORTAL_EVENT_TYPES = new Set([
  'visibility_hidden',
  'visibility_visible',
  'window_blurred',
  'window_focused',
  'fullscreen_entered',
  'fullscreen_exited',
  'fullscreen_unsupported',
  'copy_blocked',
  'paste_blocked',
]);

export const MIME_EXTENSION_MAP: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
};

export interface TestRow {
  id: string;
  title: string;
  description: string;
  instructions_latex: string;
  duration_minutes: number;
  security_mode: 'one_sitting' | 'take_home';
  require_fullscreen: boolean;
  block_clipboard: boolean;
  opens_at: string | null;
  closes_at: string | null;
  status: 'draft' | 'published' | 'archived';
  show_results: boolean;
  created_at: string;
  updated_at: string;
}

export interface QuestionOption {
  id: string;
  label: string;
}

export interface QuestionRow {
  id: string;
  test_id: string;
  position: number;
  title: string;
  prompt_latex: string;
  answer_type: 'numerical' | 'multiple_choice' | 'file_upload';
  options: QuestionOption[] | unknown;
  points: number | string;
  file_extensions: string[];
  max_file_size_mb: number;
}

export interface AttemptRow {
  id: string;
  test_id: string;
  user_id: string;
  participant_email: string;
  participant_name: string;
  status: 'in_progress' | 'submitted' | 'timed_out';
  started_at: string;
  expires_at: string;
  submitted_at: string | null;
  last_seen_at: string;
  security_session_hash: string | null;
  auto_submitted: boolean;
  extension_minutes: number;
  deadline_extended_at: string | null;
  deadline_extended_by: string | null;
  score: number | string | null;
  auto_score: number | string | null;
  max_score: number | string;
  grading_status: 'pending' | 'pending_manual' | 'complete';
}

export interface ResponseRow {
  id: string;
  attempt_id: string;
  question_id: string;
  response_text: string | null;
  selected_choice: string | null;
  file_path: string | null;
  file_name: string | null;
  file_mime_type: string | null;
  is_correct: boolean | null;
  points_awarded: number | string | null;
  grading_status: 'ungraded' | 'autograded' | 'pending_manual' | 'manually_graded';
  feedback: string;
  answered_at: string;
  updated_at: string;
}

export function hashPortalSession(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function calculateAttemptExpiry(test: TestRow, startedAt: Date, extensionMinutes = 0) {
  let expiresAt = new Date(startedAt.getTime() + test.duration_minutes * 60_000);
  if (test.closes_at) {
    const closesAt = new Date(test.closes_at);
    if (closesAt < expiresAt) expiresAt = closesAt;
  }
  return new Date(expiresAt.getTime() + Math.max(0, extensionMinutes) * 60_000);
}

export function getTestAvailability(test: TestRow, now = new Date()) {
  if (test.status !== 'published') return 'unavailable' as const;
  if (test.opens_at && now < new Date(test.opens_at)) return 'upcoming' as const;
  if (test.closes_at && now >= new Date(test.closes_at)) return 'closed' as const;
  return 'open' as const;
}

export function normalizeQuestionOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const id = typeof (entry as Record<string, unknown>).id === 'string'
      ? String((entry as Record<string, unknown>).id).trim()
      : '';
    const label = typeof (entry as Record<string, unknown>).label === 'string'
      ? String((entry as Record<string, unknown>).label).trim()
      : '';
    if (!id || !label || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label }];
  });
}

export function publicQuestion(question: QuestionRow) {
  return {
    id: question.id,
    position: question.position,
    title: question.title,
    prompt_latex: question.prompt_latex,
    answer_type: question.answer_type,
    options: normalizeQuestionOptions(question.options),
    points: Number(question.points),
    file_extensions: question.file_extensions,
    max_file_size_mb: question.max_file_size_mb,
  };
}

export function publicResponse(response: ResponseRow, showGrade = false) {
  return {
    id: response.id,
    question_id: response.question_id,
    response_text: response.response_text,
    selected_choice: response.selected_choice,
    file_name: response.file_name,
    answered_at: response.answered_at,
    updated_at: response.updated_at,
    ...(showGrade ? {
      is_correct: response.is_correct,
      points_awarded: response.points_awarded === null ? null : Number(response.points_awarded),
      grading_status: response.grading_status,
      feedback: response.feedback,
    } : {}),
  };
}

export function requireAttemptSession(request: Request, attempt: AttemptRow, test: TestRow) {
  if (test.security_mode !== 'one_sitting' || attempt.status !== 'in_progress') return;
  const token = request.headers.get('x-test-session')?.trim() ?? '';
  if (!token || !attempt.security_session_hash || hashPortalSession(token) !== attempt.security_session_hash) {
    throw new PortalHttpError(
      409,
      'SESSION_LOCKED',
      'This one-sitting attempt is locked to the browser tab where it was started. Ask an administrator to unlock it if the tab was lost.',
    );
  }
}

export async function getOwnedAttempt(
  supabase: SupabaseClient,
  attemptId: string,
  userId: string,
) {
  const { data: attempt, error } = await supabase
    .from('test_attempts')
    .select('*')
    .eq('id', attemptId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!attempt) throw new PortalHttpError(404, 'ATTEMPT_NOT_FOUND', 'That test attempt was not found.');

  const { data: test, error: testError } = await supabase
    .from('tests')
    .select('*')
    .eq('id', attempt.test_id)
    .single();

  if (testError || !test) throw testError ?? new Error('Test not found');
  return { attempt: attempt as AttemptRow, test: test as TestRow };
}

export async function logSecurityEvent(
  supabase: SupabaseClient,
  attempt: Pick<AttemptRow, 'id' | 'user_id'>,
  eventType: string,
  metadata: Record<string, unknown> = {},
) {
  const serialized = JSON.stringify(metadata);
  const safeMetadata = serialized.length <= 4000
    ? JSON.parse(serialized) as Record<string, unknown>
    : { truncated: true };
  const { error } = await supabase.from('test_security_events').insert({
    attempt_id: attempt.id,
    user_id: attempt.user_id,
    event_type: eventType,
    metadata: safeMetadata,
  });
  if (error) throw error;
}

export async function logAdminAudit(
  supabase: SupabaseClient,
  adminUserId: string,
  action: string,
  references: {
    test_id?: string | null;
    attempt_id?: string | null;
    question_id?: string | null;
    response_id?: string | null;
  } = {},
  metadata: Record<string, unknown> = {},
) {
  const serialized = JSON.stringify(metadata);
  const safeMetadata = serialized.length <= 8000
    ? JSON.parse(serialized) as Record<string, unknown>
    : { truncated: true };
  const { error } = await supabase.from('test_admin_audit_log').insert({
    admin_user_id: adminUserId,
    action,
    ...references,
    metadata: safeMetadata,
  });
  if (error) throw error;
}

export async function finalizeAttempt(
  supabase: SupabaseClient,
  attempt: AttemptRow,
  reason: 'submitted' | 'timed_out',
) {
  if (attempt.status !== 'in_progress') return attempt;

  const [{ data: questions, error: questionError }, { data: responses, error: responseError }] = await Promise.all([
    supabase.from('test_questions').select('*').eq('test_id', attempt.test_id).order('position'),
    supabase.from('test_responses').select('*').eq('attempt_id', attempt.id),
  ]);
  if (questionError) throw questionError;
  if (responseError) throw responseError;

  const questionRows = (questions ?? []) as QuestionRow[];
  const questionIds = questionRows.map((question) => question.id);
  const { data: keys, error: keyError } = questionIds.length
    ? await supabase.from('test_question_keys').select('*').in('question_id', questionIds)
    : { data: [], error: null };
  if (keyError) throw keyError;

  const keyByQuestion = new Map((keys ?? []).map((key) => [key.question_id, key]));
  const responseByQuestion = new Map(((responses ?? []) as ResponseRow[]).map((response) => [response.question_id, response]));
  let autoScore = 0;
  let manualScore = 0;
  let pendingManual = false;

  for (const question of questionRows) {
    const response = responseByQuestion.get(question.id);
    if (!response) continue;

    const points = Number(question.points);
    if (question.answer_type === 'file_upload') {
      if (response.grading_status === 'manually_graded') {
        manualScore += Number(response.points_awarded ?? 0);
      } else if (response.file_path) {
        pendingManual = true;
        const { error } = await supabase
          .from('test_responses')
          .update({ grading_status: 'pending_manual', is_correct: null, points_awarded: null })
          .eq('id', response.id);
        if (error) throw error;
      }
      continue;
    }

    const key = keyByQuestion.get(question.id);
    let correct = false;
    if (question.answer_type === 'numerical' && key?.numerical_answer !== null && key?.numerical_answer !== undefined) {
      const submitted = Number(response.response_text);
      const expected = Number(key.numerical_answer);
      const tolerance = Number(key.numerical_tolerance ?? 0);
      correct = Number.isFinite(submitted) && Math.abs(submitted - expected) <= tolerance;
    } else if (question.answer_type === 'multiple_choice' && key?.choice_key) {
      correct = response.selected_choice === key.choice_key;
    }

    const awarded = correct ? points : 0;
    autoScore += awarded;
    const { error } = await supabase
      .from('test_responses')
      .update({
        is_correct: correct,
        points_awarded: awarded,
        grading_status: 'autograded',
      })
      .eq('id', response.id);
    if (error) throw error;
  }

  const maxScore = questionRows.reduce((sum, question) => sum + Number(question.points), 0);
  const status = reason === 'timed_out' ? 'timed_out' : 'submitted';
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from('test_attempts')
    .update({
      status,
      submitted_at: now,
      last_seen_at: now,
      auto_submitted: reason === 'timed_out',
      auto_score: autoScore,
      score: autoScore + manualScore,
      max_score: maxScore,
      grading_status: pendingManual ? 'pending_manual' : 'complete',
    })
    .eq('id', attempt.id)
    .eq('status', 'in_progress')
    .select('*')
    .maybeSingle();
  if (updateError) throw updateError;

  if (updated) {
    await logSecurityEvent(supabase, attempt, reason);
    return updated as AttemptRow;
  }

  const { data: current, error: currentError } = await supabase
    .from('test_attempts')
    .select('*')
    .eq('id', attempt.id)
    .single();
  if (currentError) throw currentError;
  return current as AttemptRow;
}

export async function finalizeIfExpired(supabase: SupabaseClient, attempt: AttemptRow) {
  if (attempt.status === 'in_progress' && Date.now() >= new Date(attempt.expires_at).getTime()) {
    return finalizeAttempt(supabase, attempt, 'timed_out');
  }
  return attempt;
}

export function createUploadPath(userId: string, attemptId: string, questionId: string, extension: string) {
  return `${userId}/${attemptId}/${questionId}/${randomUUID()}.${extension}`;
}

export async function storageObjectExists(supabase: SupabaseClient, path: string) {
  return Boolean(await getStorageObject(supabase, path));
}

export async function getStorageObject(supabase: SupabaseClient, path: string) {
  const slash = path.lastIndexOf('/');
  if (slash < 1) return null;
  const folder = path.slice(0, slash);
  const fileName = path.slice(slash + 1);
  const { data, error } = await supabase.storage
    .from(TEST_SUBMISSIONS_BUCKET)
    .list(folder, { limit: 10, search: fileName });
  if (error) throw error;
  return (data ?? []).find((entry) => entry.name === fileName) ?? null;
}

export async function storageObjectMatchesMimeType(
  supabase: SupabaseClient,
  path: string,
  mimeType: string,
) {
  const { data, error } = await supabase.storage
    .from(TEST_SUBMISSIONS_BUCKET)
    .createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw error ?? new Error('Could not inspect the uploaded file');

  const response = await fetch(data.signedUrl, {
    headers: { Range: 'bytes=0-1023' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Could not inspect the uploaded file (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer()).subarray(0, 1024);
  const startsWith = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);

  if (mimeType === 'image/png') return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mimeType === 'image/jpeg') return startsWith(0xff, 0xd8, 0xff);
  if (mimeType === 'image/webp') {
    return startsWith(0x52, 0x49, 0x46, 0x46)
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  if (mimeType === 'application/pdf') {
    const signature = [0x25, 0x50, 0x44, 0x46, 0x2d];
    return bytes.some((_, offset) => offset <= bytes.length - signature.length
      && signature.every((value, index) => bytes[offset + index] === value));
  }
  return false;
}
