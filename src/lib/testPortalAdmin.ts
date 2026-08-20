import type { SupabaseClient } from '@supabase/supabase-js';
import { MIME_EXTENSION_MAP, normalizeQuestionOptions } from './testPortal';
import { PortalHttpError, stringField } from './testPortalAuth';

const ANSWER_TYPES = new Set(['numerical', 'multiple_choice', 'file_upload']);
const ALLOWED_EXTENSIONS = new Set(Object.values(MIME_EXTENSION_MAP).flat());

export async function ensureTestStructureEditable(supabase: SupabaseClient, testId: string) {
  const { count, error } = await supabase
    .from('test_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('test_id', testId);
  if (error) throw error;
  if ((count ?? 0) > 0) {
    throw new PortalHttpError(
      409,
      'TEST_STRUCTURE_LOCKED',
      'Problems and answer keys are locked after the first attempt. Duplicate this test to create a new version.',
    );
  }
}

export function validateQuestionInput(body: Record<string, unknown>) {
  const title = stringField(body.title, 'title', { max: 160 });
  const promptLatex = stringField(body.prompt_latex, 'prompt_latex', { required: true, max: 50_000 });
  const answerType = stringField(body.answer_type, 'answer_type', { required: true });
  if (!ANSWER_TYPES.has(answerType)) {
    throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Choose a supported answer format.');
  }

  const points = Number(body.points);
  if (!Number.isFinite(points) || points < 0 || points > 10_000) {
    throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Points must be between 0 and 10,000.');
  }

  const gradingNotes = stringField(body.grading_notes, 'grading_notes', { max: 20_000 });
  const question: Record<string, unknown> = {
    title,
    prompt_latex: promptLatex,
    answer_type: answerType,
    points,
    options: [],
    file_extensions: ['pdf', 'png', 'jpg', 'jpeg'],
    max_file_size_mb: 10,
  };
  const key: Record<string, unknown> = {
    numerical_answer: null,
    numerical_tolerance: 0,
    choice_key: null,
    grading_notes: gradingNotes,
  };

  if (answerType === 'numerical') {
    const rawAnswer = body.numerical_answer;
    if (rawAnswer === null || rawAnswer === undefined || String(rawAnswer).trim() === '') {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'A numerical answer is required.');
    }
    const numericalAnswer = Number(rawAnswer);
    const tolerance = Number(body.numerical_tolerance ?? 0);
    if (!Number.isFinite(numericalAnswer)) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'The numerical answer must be a valid number.');
    }
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Numerical tolerance must be zero or greater.');
    }
    key.numerical_answer = numericalAnswer;
    key.numerical_tolerance = tolerance;
  } else if (answerType === 'multiple_choice') {
    const options = normalizeQuestionOptions(body.options);
    if (options.length < 2 || options.length > 12) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Multiple-choice problems need 2–12 unique choices.');
    }
    const choiceKey = stringField(body.choice_key, 'choice_key', { required: true, max: 80 });
    if (!options.some((option) => option.id === choiceKey)) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Mark one of the listed choices as correct.');
    }
    question.options = options;
    key.choice_key = choiceKey;
  } else {
    const extensions = Array.isArray(body.file_extensions)
      ? [...new Set(body.file_extensions.map((entry) => String(entry).trim().toLowerCase()))]
      : [];
    if (!extensions.length || extensions.some((extension) => !ALLOWED_EXTENSIONS.has(extension))) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Choose at least one supported upload type.');
    }
    const maxFileSize = Number(body.max_file_size_mb);
    if (!Number.isInteger(maxFileSize) || maxFileSize < 1 || maxFileSize > 25) {
      throw new PortalHttpError(400, 'VALIDATION_ERROR', 'Upload size must be between 1 and 25 MB.');
    }
    question.file_extensions = extensions;
    question.max_file_size_mb = maxFileSize;
  }

  return { question, key };
}

