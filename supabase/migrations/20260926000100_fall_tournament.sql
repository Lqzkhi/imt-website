-- Fall qualifier, atomic submission, deadline enforcement, and private scratch work.
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS contest_section TEXT
  CHECK (contest_section IN ('computational', 'proof'));
CREATE UNIQUE INDEX IF NOT EXISTS tests_fall_section ON public.tests(contest_section)
  WHERE contest_section IS NOT NULL;
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT FALSE;

-- Reuse the untouched Fall drafts already present in the live portal.
UPDATE public.tests SET contest_section='computational'
WHERE title='Fall 2026 Round 1 — Computational Section' AND status='draft' AND contest_section IS NULL
AND NOT EXISTS(SELECT 1 FROM public.test_attempts a WHERE a.test_id=tests.id)
AND NOT EXISTS(SELECT 1 FROM public.tests t WHERE t.contest_section='computational');
UPDATE public.tests SET contest_section='proof'
WHERE title='Fall 2026 Round 1 — Proof Section' AND status='draft' AND contest_section IS NULL
AND NOT EXISTS(SELECT 1 FROM public.test_attempts a WHERE a.test_id=tests.id)
AND NOT EXISTS(SELECT 1 FROM public.tests t WHERE t.contest_section='proof');

INSERT INTO public.tests (title, description, instructions_latex, duration_minutes,
  security_mode, require_fullscreen, block_clipboard, opens_at, closes_at, contest_section)
VALUES
('Fall 2026 IMT · Computational', '20 numerical problems · 2 hours · 50% of your Round 1 score.',
 'Work independently. Complete this section in one sitting. Your timer cannot pause. Save numerical answers and upload optional scratch work before your deadline. The earlier of your personal timer and the tournament closing time applies. Submit only when ready; submitted answers cannot be changed.',
 120, 'one_sitting', FALSE, FALSE, '2026-09-26 00:00:00-04', '2026-10-11 00:00:00-04', 'computational'),
('Fall 2026 IMT · Proof', '5 written proofs · 4.5 hours · 7 points per problem · 50% of your Round 1 score.',
 'Work independently. Complete this section in one sitting, separately from the computational section. Upload a legible PDF or image for each proof; partial credit is available. Scratch uploads are supplementary and do not replace proof answers. Upload and save before the earlier of your personal timer and the tournament closing time. Submitted work cannot be changed.',
 270, 'one_sitting', FALSE, FALSE, '2026-09-26 00:00:00-04', '2026-10-11 00:00:00-04', 'proof')
ON CONFLICT (contest_section) WHERE contest_section IS NOT NULL DO NOTHING;

UPDATE public.tests t SET duration_minutes=CASE WHEN contest_section='proof' THEN 270 ELSE 120 END,
 security_mode='one_sitting', require_fullscreen=FALSE, block_clipboard=FALSE,
 opens_at='2026-09-26 00:00:00-04', closes_at='2026-10-11 00:00:00-04'
WHERE contest_section IS NOT NULL AND status='draft' AND NOT EXISTS(SELECT 1 FROM public.test_attempts a WHERE a.test_id=t.id);

INSERT INTO public.test_questions (test_id, position, title, prompt_latex, answer_type, points, is_placeholder)
SELECT t.id, n, 'Problem ' || n, 'Problem not released. Replace this statement before publishing.',
  CASE WHEN t.contest_section = 'proof' THEN 'file_upload' ELSE 'numerical' END,
  CASE WHEN t.contest_section = 'proof' THEN 7 ELSE 1 END, TRUE
FROM public.tests t CROSS JOIN LATERAL generate_series(1, CASE WHEN t.contest_section = 'proof' THEN 5 ELSE 20 END) n
WHERE t.contest_section IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.test_questions q WHERE q.test_id = t.id);

CREATE TABLE IF NOT EXISTS public.test_scratch_files (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 attempt_id UUID NOT NULL REFERENCES public.test_attempts(id) ON DELETE CASCADE,
 file_path TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
 mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf','image/png','image/jpeg','image/webp')),
 size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.test_scratch_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.test_scratch_files FROM anon, authenticated;
GRANT ALL ON public.test_scratch_files TO service_role;

ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS submission_source TEXT NOT NULL DEFAULT 'participant';

-- Serialize content writes against submission. Grades remain editable after submission.
CREATE OR REPLACE FUNCTION public.guard_test_content_write() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a public.test_attempts; target UUID; total INTEGER;
BEGIN
 target := CASE WHEN TG_OP = 'DELETE' THEN OLD.attempt_id ELSE NEW.attempt_id END;
 IF TG_TABLE_NAME = 'test_responses' AND TG_OP = 'UPDATE' THEN
 IF
    ROW(NEW.attempt_id,NEW.question_id,NEW.response_text,NEW.selected_choice,NEW.file_path,NEW.file_name,NEW.file_mime_type,NEW.answered_at)
    IS NOT DISTINCT FROM ROW(OLD.attempt_id,OLD.question_id,OLD.response_text,OLD.selected_choice,OLD.file_path,OLD.file_name,OLD.file_mime_type,OLD.answered_at)
 THEN RETURN NEW; END IF;
 END IF;
 SELECT * INTO a FROM public.test_attempts WHERE id = target FOR UPDATE;
 IF a.id IS NULL THEN
   IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
   RAISE EXCEPTION 'Attempt not found';
 END IF;
 IF a.status <> 'in_progress' OR a.expires_at <= clock_timestamp() THEN
   RAISE EXCEPTION 'Attempt closed: no further content changes';
 END IF;
 IF TG_TABLE_NAME = 'test_scratch_files' AND TG_OP = 'INSERT' THEN
   SELECT count(*) INTO total FROM public.test_scratch_files WHERE attempt_id = target;
   IF total >= 10 THEN RAISE EXCEPTION 'At most 10 scratch files per attempt'; END IF;
   IF NEW.file_path NOT LIKE a.user_id::TEXT || '/' || a.id::TEXT || '/scratch/%' THEN
     RAISE EXCEPTION 'Scratch file belongs to another attempt';
   END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER guard_test_response_write BEFORE INSERT OR UPDATE OR DELETE ON public.test_responses
FOR EACH ROW EXECUTE FUNCTION public.guard_test_content_write();
CREATE TRIGGER guard_test_scratch_write BEFORE INSERT OR UPDATE OR DELETE ON public.test_scratch_files
FOR EACH ROW EXECUTE FUNCTION public.guard_test_content_write();

-- A single transaction locks the attempt, grades all responses, and closes it.
CREATE OR REPLACE FUNCTION public.finalize_test_attempt(p_attempt_id UUID, p_reason TEXT DEFAULT 'timed_out')
RETURNS public.test_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.test_attempts; auto_total NUMERIC; manual_total NUMERIC; maximum NUMERIC; pending BOOLEAN;
BEGIN
 IF p_reason NOT IN ('submitted','timed_out','admin_force') THEN RAISE EXCEPTION 'Invalid submission reason'; END IF;
 SELECT * INTO a FROM public.test_attempts WHERE id = p_attempt_id FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Attempt not found'; END IF;
 IF a.status <> 'in_progress' THEN RETURN a; END IF;
 IF a.expires_at <= clock_timestamp() THEN p_reason := 'timed_out';
 ELSIF p_reason = 'timed_out' THEN RETURN a; END IF;
 UPDATE public.test_responses r SET
   is_correct = CASE WHEN q.answer_type = 'numerical' THEN
     CASE WHEN r.response_text ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$'
       THEN abs(r.response_text::NUMERIC - k.numerical_answer) <= k.numerical_tolerance ELSE FALSE END
     ELSE r.selected_choice = k.choice_key END,
   points_awarded = CASE WHEN q.answer_type = 'numerical' THEN
     CASE WHEN r.response_text ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$'
       THEN CASE WHEN abs(r.response_text::NUMERIC - k.numerical_answer) <= k.numerical_tolerance THEN q.points ELSE 0 END ELSE 0 END
     ELSE CASE WHEN r.selected_choice = k.choice_key THEN q.points ELSE 0 END END,
   grading_status = 'autograded'
 FROM public.test_questions q LEFT JOIN public.test_question_keys k ON k.question_id = q.id
 WHERE r.attempt_id = a.id AND r.question_id = q.id AND q.answer_type <> 'file_upload'
   AND r.grading_status <> 'manually_graded';
 UPDATE public.test_responses r SET grading_status = 'pending_manual'
 FROM public.test_questions q WHERE r.attempt_id = a.id AND r.question_id = q.id
 AND q.answer_type = 'file_upload' AND r.grading_status <> 'manually_graded';
 SELECT coalesce(sum(points_awarded) FILTER (WHERE grading_status = 'autograded'),0),
   coalesce(sum(points_awarded) FILTER (WHERE grading_status = 'manually_graded'),0),
   coalesce(bool_or(grading_status = 'pending_manual'),FALSE)
 INTO auto_total, manual_total, pending FROM public.test_responses WHERE attempt_id = a.id;
 SELECT coalesce(sum(points),0) INTO maximum FROM public.test_questions WHERE test_id = a.test_id;
 UPDATE public.test_attempts SET status = CASE WHEN p_reason='timed_out' THEN 'timed_out' ELSE 'submitted' END,
 submission_source = CASE WHEN p_reason='timed_out' THEN 'deadline' WHEN p_reason='admin_force' THEN 'administrator' ELSE 'participant' END,
 submitted_at = CASE WHEN p_reason = 'timed_out' THEN expires_at ELSE clock_timestamp() END,
 auto_submitted = p_reason = 'timed_out', auto_score = auto_total, score = auto_total + manual_total,
 max_score = maximum, grading_status = CASE WHEN pending THEN 'pending_manual' ELSE 'complete' END
 WHERE id = a.id RETURNING * INTO a;
 INSERT INTO public.test_security_events(attempt_id,user_id,event_type) VALUES(a.id,a.user_id,CASE WHEN p_reason='timed_out' THEN 'timed_out' ELSE 'submitted' END);
 RETURN a;
END $$;
REVOKE ALL ON FUNCTION public.finalize_test_attempt(UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_test_attempt(UUID,TEXT) TO service_role;

CREATE TABLE public.test_portal_job_health (name TEXT PRIMARY KEY, last_run_at TIMESTAMPTZ, processed INTEGER NOT NULL DEFAULT 0);
ALTER TABLE public.test_portal_job_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.test_portal_job_health FROM anon, authenticated;
GRANT ALL ON public.test_portal_job_health TO service_role;
CREATE OR REPLACE FUNCTION public.submit_expired_test_attempts() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE target UUID; total INTEGER := 0;
BEGIN
 FOR target IN SELECT id FROM public.test_attempts WHERE status = 'in_progress' AND expires_at <= clock_timestamp()
 ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED LOOP
   PERFORM public.finalize_test_attempt(target,'timed_out'); total := total + 1;
 END LOOP;
 INSERT INTO public.test_portal_job_health(name,last_run_at,processed) VALUES('auto_submit',clock_timestamp(),total)
 ON CONFLICT(name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, processed = EXCLUDED.processed;
 DELETE FROM public.test_portal_rate_limits WHERE updated_at < NOW() - INTERVAL '2 days';
 RETURN total;
END $$;
REVOKE ALL ON FUNCTION public.submit_expired_test_attempts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_expired_test_attempts() TO service_role;

-- Align active personal deadlines atomically whenever the closing time is edited.
CREATE OR REPLACE FUNCTION public.sync_test_deadlines() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 UPDATE public.test_attempts SET expires_at = LEAST(
 started_at + make_interval(mins => NEW.duration_minutes + extension_minutes),
 coalesce(NEW.closes_at,'infinity'::TIMESTAMPTZ))
 WHERE test_id = NEW.id AND status = 'in_progress';
 RETURN NEW;
END $$;
CREATE TRIGGER sync_test_deadlines AFTER UPDATE OF duration_minutes,closes_at ON public.tests
FOR EACH ROW EXECUTE FUNCTION public.sync_test_deadlines();

CREATE OR REPLACE FUNCTION public.grade_test_response(p_response_id UUID, p_admin_id UUID, p_points NUMERIC, p_feedback TEXT, p_expected_graded_at TIMESTAMPTZ)
RETURNS SETOF public.test_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.test_responses; a public.test_attempts; q public.test_questions; total NUMERIC; pending BOOLEAN;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.test_admins WHERE user_id = p_admin_id) THEN RAISE EXCEPTION 'Administrator required'; END IF;
 SELECT * INTO r FROM public.test_responses WHERE id = p_response_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Response not found'; END IF;
 SELECT * INTO a FROM public.test_attempts WHERE id = r.attempt_id FOR UPDATE;
 SELECT * INTO r FROM public.test_responses WHERE id = p_response_id FOR UPDATE;
 IF a.status = 'in_progress' THEN RAISE EXCEPTION 'Submit before grading'; END IF;
 IF r.graded_at IS DISTINCT FROM p_expected_graded_at THEN RAISE EXCEPTION 'Grade changed by another grader'; END IF;
 SELECT * INTO q FROM public.test_questions WHERE id = r.question_id;
 IF p_points IS NULL OR p_points < 0 OR p_points > q.points OR p_points::TEXT = 'NaN' OR char_length(p_feedback) > 10000 THEN RAISE EXCEPTION 'Invalid grade'; END IF;
 UPDATE public.test_responses SET points_awarded = p_points, is_correct = p_points = q.points,
 grading_status = 'manually_graded', feedback = coalesce(p_feedback,''), graded_by = p_admin_id, graded_at = clock_timestamp() WHERE id = r.id;
 SELECT coalesce(sum(points_awarded),0),coalesce(bool_or(grading_status = 'pending_manual'),FALSE)
 INTO total,pending FROM public.test_responses WHERE attempt_id = a.id;
 UPDATE public.test_attempts SET score = total, grading_status = CASE WHEN pending THEN 'pending_manual' ELSE 'complete' END
 WHERE id = a.id RETURNING * INTO a;
 INSERT INTO public.test_admin_audit_log(admin_user_id,action,test_id,attempt_id,question_id,response_id,metadata)
 VALUES(p_admin_id,'response_grade_overridden',a.test_id,a.id,q.id,r.id,
 jsonb_build_object('previous_points',r.points_awarded,'points_awarded',p_points,'max_points',q.points));
 INSERT INTO public.test_security_events(attempt_id,user_id,event_type,metadata)
 VALUES(a.id,a.user_id,'grade_overridden_by_admin',jsonb_build_object('admin_user_id',p_admin_id,'question_id',q.id));
 RETURN NEXT a;
END $$;
REVOKE ALL ON FUNCTION public.grade_test_response(UUID,UUID,NUMERIC,TEXT,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.grade_test_response(UUID,UUID,NUMERIC,TEXT,TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_test_start() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE t public.tests; n INTEGER;
BEGIN
 SELECT * INTO t FROM public.tests WHERE id = NEW.test_id FOR UPDATE;
 IF t.status <> 'published' OR t.opens_at > clock_timestamp() OR t.closes_at <= clock_timestamp() THEN RAISE EXCEPTION 'Test is not open'; END IF;
 SELECT count(*) INTO n FROM public.test_questions WHERE test_id = t.id;
 IF t.contest_section IS NOT NULL AND (n <> CASE WHEN t.contest_section='proof' THEN 5 ELSE 20 END OR EXISTS(SELECT 1 FROM public.test_questions WHERE test_id=t.id AND (answer_type <> CASE WHEN t.contest_section='proof' THEN 'file_upload' ELSE 'numerical' END OR (t.contest_section='proof' AND points<>7)))) THEN RAISE EXCEPTION 'Contest format invalid'; END IF;
 IF n = 0 OR EXISTS(SELECT 1 FROM public.test_questions WHERE test_id=t.id AND is_placeholder) THEN RAISE EXCEPTION 'Problems are not ready'; END IF;
 IF EXISTS(SELECT 1 FROM public.test_questions q LEFT JOIN public.test_question_keys k ON k.question_id=q.id
   WHERE q.test_id=t.id AND ((q.answer_type='numerical' AND k.numerical_answer IS NULL) OR (q.answer_type='multiple_choice' AND k.choice_key IS NULL))) THEN RAISE EXCEPTION 'Answer key missing'; END IF;
 NEW.expires_at := LEAST(NEW.started_at+make_interval(mins=>t.duration_minutes+NEW.extension_minutes),coalesce(t.closes_at,'infinity'::TIMESTAMPTZ));
 RETURN NEW;
END $$;
CREATE TRIGGER guard_test_start BEFORE INSERT ON public.test_attempts FOR EACH ROW EXECUTE FUNCTION public.guard_test_start();

CREATE OR REPLACE FUNCTION public.guard_test_authoring() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE target UUID;
BEGIN
 IF TG_TABLE_NAME='test_questions' THEN
   target := CASE WHEN TG_OP='DELETE' THEN OLD.test_id ELSE NEW.test_id END;
 ELSE
   SELECT test_id INTO target FROM public.test_questions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.question_id ELSE NEW.question_id END;
 END IF;
 PERFORM id FROM public.tests WHERE id=target FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.test_attempts WHERE test_id=target) THEN RAISE EXCEPTION 'Test structure locked after first attempt'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER guard_test_question_authoring BEFORE INSERT OR UPDATE OR DELETE ON public.test_questions FOR EACH ROW EXECUTE FUNCTION public.guard_test_authoring();
CREATE TRIGGER guard_test_key_authoring BEFORE INSERT OR UPDATE OR DELETE ON public.test_question_keys FOR EACH ROW EXECUTE FUNCTION public.guard_test_authoring();

CREATE OR REPLACE FUNCTION public.guard_result_release() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 IF NEW.show_results AND NOT OLD.show_results THEN
   IF NEW.closes_at IS NULL OR NEW.closes_at > clock_timestamp() THEN RAISE EXCEPTION 'Wait until the contest closes before releasing results'; END IF;
   IF EXISTS(SELECT 1 FROM public.test_attempts WHERE test_id=NEW.id AND (status='in_progress' OR grading_status<>'complete')) THEN RAISE EXCEPTION 'Finish submission processing and grading before releasing results'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_result_release BEFORE UPDATE OF show_results ON public.tests FOR EACH ROW EXECUTE FUNCTION public.guard_result_release();
