import type { APIRoute } from 'astro';
import {
  finalizeIfExpired,
  getOwnedAttempt,
  getStorageObject,
  MIME_EXTENSION_MAP,
  normalizeQuestionOptions,
  requireAttemptSession,
  storageObjectMatchesMimeType,
  TEST_SUBMISSIONS_BUCKET,
  type QuestionRow,
  type ResponseRow,
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

    const { supabase, user } = await authenticatePortalRequest(request);
    const owned = await getOwnedAttempt(supabase, params.attemptId ?? '', user.id);
    const attempt = await finalizeIfExpired(supabase, owned.attempt);
    if (attempt.status !== 'in_progress') {
      throw new PortalHttpError(409, 'ATTEMPT_CLOSED', 'This attempt has already been submitted.');
    }
    requireAttemptSession(request, attempt, owned.test);

    const body = await readPortalJson(request);
    const questionId = uuidField(body.question_id, 'question_id');
    const { data: questionData, error: questionError } = await supabase
      .from('test_questions')
      .select('*')
      .eq('id', questionId)
      .eq('test_id', owned.test.id)
      .maybeSingle();
    if (questionError) throw questionError;
    if (!questionData) throw new PortalHttpError(404, 'QUESTION_NOT_FOUND', 'That problem was not found.');
    const question = questionData as QuestionRow;

    const { data: previousData, error: previousError } = await supabase
      .from('test_responses')
      .select('*')
      .eq('attempt_id', attempt.id)
      .eq('question_id', question.id)
      .maybeSingle();
    if (previousError) throw previousError;
    const previous = previousData as ResponseRow | null;

    if (body.clear === true) {
      if (previous?.file_path) {
        await supabase.storage.from(TEST_SUBMISSIONS_BUCKET).remove([previous.file_path]);
      }
      if (previous) {
        const { error } = await supabase.from('test_responses').delete().eq('id', previous.id);
        if (error) throw error;
      }
      return portalJson({ response: null, saved_at: new Date().toISOString() });
    }

    const payload: Record<string, unknown> = {
      attempt_id: attempt.id,
      question_id: question.id,
      response_text: null,
      selected_choice: null,
      file_path: null,
      file_name: null,
      file_mime_type: null,
      is_correct: null,
      points_awarded: null,
      grading_status: 'ungraded',
      feedback: '',
      answered_at: new Date().toISOString(),
    };

    if (question.answer_type === 'numerical') {
      const responseText = stringField(body.response_text, 'response_text', { required: true, max: 120 });
      if (!Number.isFinite(Number(responseText))) {
        throw new PortalHttpError(400, 'INVALID_NUMBER', 'Enter a valid number, such as -3, 0.5, or 1e6.');
      }
      payload.response_text = responseText;
    } else if (question.answer_type === 'multiple_choice') {
      const selectedChoice = stringField(body.selected_choice, 'selected_choice', { required: true, max: 80 });
      const options = normalizeQuestionOptions(question.options);
      if (!options.some((option) => option.id === selectedChoice)) {
        throw new PortalHttpError(400, 'INVALID_CHOICE', 'Select one of the available choices.');
      }
      payload.selected_choice = selectedChoice;
    } else {
      const filePath = stringField(body.file_path, 'file_path', { required: true, max: 500 });
      const fileName = stringField(body.file_name, 'file_name', { required: true, max: 255 });
      const mimeType = stringField(body.file_mime_type, 'file_mime_type', { required: true, max: 100 }).toLowerCase();
      const requiredPrefix = `${user.id}/${attempt.id}/${question.id}/`;
      if (!filePath.startsWith(requiredPrefix) || filePath.includes('..')) {
        throw new PortalHttpError(400, 'INVALID_UPLOAD_PATH', 'The uploaded file does not belong to this response.');
      }
      const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
      const allowedExtensions = (question.file_extensions ?? []).map((entry) => entry.toLowerCase());
      if (!allowedExtensions.includes(extension) || !(MIME_EXTENSION_MAP[mimeType] ?? []).includes(extension)) {
        throw new PortalHttpError(400, 'FILE_TYPE_NOT_ALLOWED', 'That file type is not allowed for this problem.');
      }
      const storageObject = await getStorageObject(supabase, filePath);
      if (!storageObject) {
        throw new PortalHttpError(400, 'UPLOAD_NOT_FOUND', 'The file upload did not finish. Please upload it again.');
      }
      const storedSize = Number((storageObject.metadata as Record<string, unknown> | null)?.size ?? 0);
      if (storedSize > question.max_file_size_mb * 1024 * 1024) {
        await supabase.storage.from(TEST_SUBMISSIONS_BUCKET).remove([filePath]);
        throw new PortalHttpError(413, 'FILE_TOO_LARGE', `This file exceeds the ${question.max_file_size_mb} MB limit.`);
      }
      const storedMetadata = storageObject.metadata as Record<string, unknown> | null;
      const storedMimeType = String(storedMetadata?.mimetype ?? storedMetadata?.contentType ?? '').toLowerCase();
      if ((storedMimeType && storedMimeType !== mimeType) || !(await storageObjectMatchesMimeType(supabase, filePath, mimeType))) {
        await supabase.storage.from(TEST_SUBMISSIONS_BUCKET).remove([filePath]);
        throw new PortalHttpError(400, 'FILE_CONTENT_INVALID', 'The uploaded file contents do not match its file type.');
      }
      payload.file_path = filePath;
      payload.file_name = fileName;
      payload.file_mime_type = mimeType;
    }

    const { data: saved, error: saveError } = await supabase
      .from('test_responses')
      .upsert(payload, { onConflict: 'attempt_id,question_id' })
      .select('*')
      .single();
    if (saveError) throw saveError;

    if (previous?.file_path && previous.file_path !== saved.file_path) {
      await supabase.storage.from(TEST_SUBMISSIONS_BUCKET).remove([previous.file_path]);
    }
    await supabase.from('test_attempts').update({ last_seen_at: new Date().toISOString() }).eq('id', attempt.id);

    return portalJson({
      response: {
        id: saved.id,
        question_id: saved.question_id,
        response_text: saved.response_text,
        selected_choice: saved.selected_choice,
        file_name: saved.file_name,
        answered_at: saved.answered_at,
      },
      saved_at: new Date().toISOString(),
    });
  } catch (error) {
    return portalErrorResponse(error);
  }
};
