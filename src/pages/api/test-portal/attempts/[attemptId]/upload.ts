import type { APIRoute } from 'astro';
import {
  createUploadPath,
  finalizeIfExpired,
  getOwnedAttempt,
  MIME_EXTENSION_MAP,
  requireAttemptSession,
  TEST_SUBMISSIONS_BUCKET,
  type QuestionRow,
} from '../../../../../lib/testPortal';
import {
  authenticatePortalRequest,
  PortalHttpError,
  portalErrorResponse,
  portalJson,
  readPortalJson,
  stringField,
  uuidField,
} from '../../../../../lib/testPortalAuth';
import { requireSameOrigin } from '../../../../../lib/requestGuards';

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const blocked = requireSameOrigin(request);
    if (blocked) return blocked;

    const { supabase, user } = await authenticatePortalRequest(request, {
      rateLimit: { limit: 30, windowSeconds: 60, scope: 'answer-upload' },
    });
    const owned = await getOwnedAttempt(supabase, params.attemptId ?? '', user.id);
    const attempt = await finalizeIfExpired(supabase, owned.attempt);
    if (attempt.status !== 'in_progress') {
      throw new PortalHttpError(409, 'ATTEMPT_CLOSED', 'This attempt has already ended.');
    }
    requireAttemptSession(request, attempt, owned.test);

    const body = await readPortalJson(request);
    const questionId = uuidField(body.question_id, 'question_id');
    const fileName = stringField(body.file_name, 'file_name', { required: true, max: 255 });
    const mimeType = stringField(body.mime_type, 'mime_type', { required: true, max: 100 }).toLowerCase();
    const size = Number(body.size);

    const { data: questionData, error: questionError } = await supabase
      .from('test_questions')
      .select('*')
      .eq('id', questionId)
      .eq('test_id', owned.test.id)
      .maybeSingle();
    if (questionError) throw questionError;
    if (!questionData) throw new PortalHttpError(404, 'QUESTION_NOT_FOUND', 'That problem was not found.');
    const question = questionData as QuestionRow;
    if (question.answer_type !== 'file_upload') {
      throw new PortalHttpError(400, 'UPLOAD_NOT_EXPECTED', 'This problem does not accept a file upload.');
    }
    if (!Number.isFinite(size) || size <= 0 || size > question.max_file_size_mb * 1024 * 1024) {
      throw new PortalHttpError(413, 'FILE_TOO_LARGE', `Choose a file no larger than ${question.max_file_size_mb} MB.`);
    }

    const mimeExtensions = MIME_EXTENSION_MAP[mimeType] ?? [];
    const originalExtension = fileName.split('.').pop()?.toLowerCase() ?? '';
    const allowedExtensions = (question.file_extensions ?? []).map((entry) => entry.toLowerCase());
    const extension = mimeExtensions.includes(originalExtension) ? originalExtension : mimeExtensions[0];
    if (!extension || !allowedExtensions.includes(extension)) {
      throw new PortalHttpError(400, 'FILE_TYPE_NOT_ALLOWED', `Allowed file types: ${allowedExtensions.join(', ')}.`);
    }

    const path = createUploadPath(user.id, attempt.id, question.id, extension);
    const { data, error } = await supabase.storage
      .from(TEST_SUBMISSIONS_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data?.token) throw error ?? new Error('Signed upload URL was not created');

    return portalJson({ path, token: data.token, file_name: fileName, mime_type: mimeType });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
