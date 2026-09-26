import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { authenticatePortalRequest, PortalHttpError, portalErrorResponse, portalJson, uuidField } from '../../../../../lib/testPortalAuth';
import { finalizeIfExpired, getOwnedAttempt, requireAttemptSession, requireProofUploadPhase, MIME_EXTENSION_MAP, storageObjectMatchesMimeType, TEST_SUBMISSIONS_BUCKET } from '../../../../../lib/testPortal';
import { requireSameOrigin } from '../../../../../lib/requestGuards';

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const { supabase, user } = await authenticatePortalRequest(request);
    const owned = await getOwnedAttempt(supabase, params.attemptId ?? '', user.id);
    const attempt = await finalizeIfExpired(supabase, owned.attempt);
    requireAttemptSession(request, attempt, owned.test);
    const { data, error } = await supabase.from('test_scratch_files').select('id,file_name,created_at,size_bytes').eq('attempt_id', attempt.id).order('created_at');
    if (error) throw error;
    return portalJson({ files: data ?? [], editable: attempt.status === 'in_progress' && (owned.test.contest_section !== 'proof' || Boolean(attempt.working_ended_at)) });
  } catch (error) { return portalErrorResponse(error); }
};

export const POST: APIRoute = async ({ request, params }) => {
  let uploadedPath = '';
  let client: Awaited<ReturnType<typeof authenticatePortalRequest>>['supabase'] | undefined;
  try {
    const blocked = requireSameOrigin(request); if (blocked) return blocked;
    const { supabase, user } = await authenticatePortalRequest(request, { rateLimit: { limit: 20, windowSeconds: 60, scope: 'scratch-upload' } });
    client = supabase;
    const owned = await getOwnedAttempt(supabase, params.attemptId ?? '', user.id);
    const attempt = await finalizeIfExpired(supabase, owned.attempt);
    if (attempt.status !== 'in_progress') throw new PortalHttpError(409, 'ATTEMPT_CLOSED', 'This attempt has ended.');
    requireAttemptSession(request, attempt, owned.test);
    requireProofUploadPhase(attempt, owned.test);
    // Keep the multipart request below Vercel's function payload limit.
    if (Number(request.headers.get('content-length')) > 4 * 1024 * 1024) throw new PortalHttpError(413, 'FILE_TOO_LARGE', 'Each scratch file must be at most 3 MB.');
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size < 1 || file.size > 3 * 1024 * 1024) throw new PortalHttpError(413, 'FILE_TOO_LARGE', 'Choose a scratch PDF or image up to 3 MB.');
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!(MIME_EXTENSION_MAP[file.type] ?? []).includes(extension)) throw new PortalHttpError(400, 'FILE_TYPE_NOT_ALLOWED', 'Use PDF, PNG, JPEG, or WebP.');
    const { count, error: countError } = await supabase.from('test_scratch_files').select('id', { count: 'exact', head: true }).eq('attempt_id', attempt.id);
    if (countError) throw countError;
    if ((count ?? 0) >= 10) throw new PortalHttpError(409, 'SCRATCH_LIMIT', 'You can upload up to 10 scratch files per section.');
    uploadedPath = `${user.id}/${attempt.id}/scratch/${randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from(TEST_SUBMISSIONS_BUCKET).upload(uploadedPath, file, { contentType: file.type, upsert: false });
    if (uploadError) throw uploadError;
    if (!(await storageObjectMatchesMimeType(supabase, uploadedPath, file.type))) throw new PortalHttpError(400, 'FILE_CONTENT_INVALID', 'File contents do not match the selected type.');
    const { error } = await supabase.from('test_scratch_files').insert({ attempt_id: attempt.id, file_path: uploadedPath, file_name: file.name.slice(0,255), mime_type: file.type, size_bytes: file.size });
    if (error) throw error;
    return portalJson({ saved: true }, { status: 201 });
  } catch (error) {
    if (uploadedPath && client) await client.storage.from(TEST_SUBMISSIONS_BUCKET).remove([uploadedPath]);
    return portalErrorResponse(error);
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request); if (blocked) return blocked;
    const { supabase, user } = await authenticatePortalRequest(request);
    const owned = await getOwnedAttempt(supabase, params.attemptId ?? '', user.id);
    const attempt = await finalizeIfExpired(supabase, owned.attempt);
    if (attempt.status !== 'in_progress') throw new PortalHttpError(409, 'ATTEMPT_CLOSED', 'This attempt has ended.');
    requireAttemptSession(request, attempt, owned.test);
    requireProofUploadPhase(attempt, owned.test);
    const id = uuidField(new URL(request.url).searchParams.get('id'), 'id');
    const { data, error } = await supabase.from('test_scratch_files').delete().eq('id',id).eq('attempt_id',attempt.id).select('file_path').maybeSingle();
    if (error) throw error;
    if (data) await supabase.storage.from(TEST_SUBMISSIONS_BUCKET).remove([data.file_path]);
    return portalJson({ removed: true });
  } catch (error) { return portalErrorResponse(error); }
};
