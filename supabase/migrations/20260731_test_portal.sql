-- Secure, reusable test portal.
-- Apply with `supabase db push` (when linked) or paste into the Supabase SQL editor.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_test_portal_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.test_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.test_admins IS
  'Users allowed to author tests, preview drafts, and review submissions.';

CREATE TABLE IF NOT EXISTS public.tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  instructions_latex TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 1 AND 43200),
  security_mode TEXT NOT NULL DEFAULT 'one_sitting'
    CHECK (security_mode IN ('one_sitting', 'take_home')),
  require_fullscreen BOOLEAN NOT NULL DEFAULT FALSE,
  block_clipboard BOOLEAN NOT NULL DEFAULT FALSE,
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  show_results BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tests_window_order CHECK (
    opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at
  )
);

CREATE TABLE IF NOT EXISTS public.test_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position > 0),
  title TEXT NOT NULL DEFAULT '',
  prompt_latex TEXT NOT NULL CHECK (char_length(prompt_latex) > 0),
  answer_type TEXT NOT NULL
    CHECK (answer_type IN ('numerical', 'multiple_choice', 'file_upload')),
  options JSONB NOT NULL DEFAULT '[]'::JSONB,
  points NUMERIC(8,2) NOT NULL DEFAULT 1 CHECK (points >= 0 AND points <= 10000),
  file_extensions TEXT[] NOT NULL DEFAULT ARRAY['pdf', 'png', 'jpg', 'jpeg'],
  max_file_size_mb INTEGER NOT NULL DEFAULT 10 CHECK (max_file_size_mb BETWEEN 1 AND 25),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (test_id, position)
);

-- Kept separate so student-facing question queries cannot accidentally include keys.
CREATE TABLE IF NOT EXISTS public.test_question_keys (
  question_id UUID PRIMARY KEY REFERENCES public.test_questions(id) ON DELETE CASCADE,
  numerical_answer NUMERIC,
  numerical_tolerance NUMERIC NOT NULL DEFAULT 0 CHECK (numerical_tolerance >= 0),
  choice_key TEXT,
  grading_notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT question_key_has_one_answer CHECK (
    (numerical_answer IS NOT NULL AND choice_key IS NULL)
    OR (numerical_answer IS NULL AND choice_key IS NOT NULL)
    OR (numerical_answer IS NULL AND choice_key IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.test_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES public.tests(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  participant_email TEXT NOT NULL DEFAULT '',
  participant_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'submitted', 'timed_out')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  security_session_hash TEXT,
  auto_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  score NUMERIC(10,2),
  auto_score NUMERIC(10,2),
  max_score NUMERIC(10,2) NOT NULL DEFAULT 0,
  grading_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (grading_status IN ('pending', 'pending_manual', 'complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (test_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.test_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES public.test_attempts(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.test_questions(id) ON DELETE RESTRICT,
  response_text TEXT,
  selected_choice TEXT,
  file_path TEXT,
  file_name TEXT,
  file_mime_type TEXT,
  is_correct BOOLEAN,
  points_awarded NUMERIC(8,2),
  grading_status TEXT NOT NULL DEFAULT 'ungraded'
    CHECK (grading_status IN ('ungraded', 'autograded', 'pending_manual', 'manually_graded')),
  feedback TEXT NOT NULL DEFAULT '',
  answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS public.test_security_events (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  attempt_id UUID NOT NULL REFERENCES public.test_attempts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'attempt_started',
    'attempt_resumed',
    'visibility_hidden',
    'visibility_visible',
    'window_blurred',
    'window_focused',
    'fullscreen_entered',
    'fullscreen_exited',
    'fullscreen_unsupported',
    'copy_blocked',
    'paste_blocked',
    'session_unlocked_by_admin',
    'submitted',
    'timed_out'
  )),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_test_questions_test_position
  ON public.test_questions(test_id, position);
CREATE INDEX IF NOT EXISTS idx_test_attempts_user
  ON public.test_attempts(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_attempts_test
  ON public.test_attempts(test_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_responses_attempt
  ON public.test_responses(attempt_id);
CREATE INDEX IF NOT EXISTS idx_test_security_events_attempt
  ON public.test_security_events(attempt_id, created_at);

DROP TRIGGER IF EXISTS set_tests_updated_at ON public.tests;
CREATE TRIGGER set_tests_updated_at
BEFORE UPDATE ON public.tests
FOR EACH ROW EXECUTE FUNCTION public.set_test_portal_updated_at();

DROP TRIGGER IF EXISTS set_test_questions_updated_at ON public.test_questions;
CREATE TRIGGER set_test_questions_updated_at
BEFORE UPDATE ON public.test_questions
FOR EACH ROW EXECUTE FUNCTION public.set_test_portal_updated_at();

DROP TRIGGER IF EXISTS set_test_question_keys_updated_at ON public.test_question_keys;
CREATE TRIGGER set_test_question_keys_updated_at
BEFORE UPDATE ON public.test_question_keys
FOR EACH ROW EXECUTE FUNCTION public.set_test_portal_updated_at();

DROP TRIGGER IF EXISTS set_test_attempts_updated_at ON public.test_attempts;
CREATE TRIGGER set_test_attempts_updated_at
BEFORE UPDATE ON public.test_attempts
FOR EACH ROW EXECUTE FUNCTION public.set_test_portal_updated_at();

DROP TRIGGER IF EXISTS set_test_responses_updated_at ON public.test_responses;
CREATE TRIGGER set_test_responses_updated_at
BEFORE UPDATE ON public.test_responses
FOR EACH ROW EXECUTE FUNCTION public.set_test_portal_updated_at();

-- All test data is accessed through authenticated server routes. With RLS enabled
-- and no client policies, anon/authenticated browser clients cannot enumerate tests,
-- responses, submissions, or answer keys through the Supabase REST API.
ALTER TABLE public.test_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_question_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_security_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.test_question_keys FROM anon, authenticated;

-- Private answer uploads. The server creates short-lived, path-specific signed
-- upload URLs and short-lived admin download URLs; the bucket is never public.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'test-submissions',
  'test-submissions',
  FALSE,
  26214400,
  ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

