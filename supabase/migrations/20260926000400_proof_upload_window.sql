-- Apply once after 001 and 003. No problem statements or answer keys are changed.
BEGIN;
-- Preserve any legacy event types while admitting the new server-generated phase event.
DO $$ DECLARE definition TEXT; BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
 WHERE conrelid='public.test_security_events'::regclass AND conname='test_security_events_event_type_check';
 IF definition IS NOT NULL THEN
  ALTER TABLE public.test_security_events DROP CONSTRAINT test_security_events_event_type_check;
  EXECUTE 'ALTER TABLE public.test_security_events ADD CONSTRAINT test_security_events_event_type_check CHECK (event_type=''proof_upload_window_started'' OR ' || substr(definition,7) || ')';
 END IF;
END $$;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS working_ended_at TIMESTAMPTZ;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS working_end_reason TEXT
 CHECK (working_end_reason IN ('submitted','timed_out'));

-- Serialize starts per participant, preventing simultaneous Fall sections.
CREATE FUNCTION public.guard_fall_single_sitting() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.tests WHERE id=NEW.test_id AND contest_section IS NOT NULL) THEN
  PERFORM 1 FROM auth.users WHERE id=NEW.user_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.test_attempts a JOIN public.tests t ON t.id=a.test_id
    WHERE a.user_id=NEW.user_id AND a.test_id<>NEW.test_id AND a.status='in_progress'
      AND t.contest_section IS NOT NULL AND
      (a.expires_at>clock_timestamp() OR (t.contest_section='proof' AND a.working_ended_at IS NULL AND a.expires_at+INTERVAL '15 minutes'>clock_timestamp())))
  THEN RAISE EXCEPTION 'Finish your other contest section before starting this one'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_fall_single_sitting BEFORE INSERT ON public.test_attempts FOR EACH ROW EXECUTE FUNCTION public.guard_fall_single_sitting();

-- Keep the existing grading implementation, including its composite return type.
ALTER FUNCTION public.finalize_test_attempt(UUID,TEXT) RENAME TO finalize_test_attempt_closed;
REVOKE ALL ON FUNCTION public.finalize_test_attempt_closed(UUID,TEXT) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.finalize_test_attempt(p_attempt_id UUID,p_reason TEXT DEFAULT 'timed_out')
RETURNS public.test_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.test_attempts; section TEXT; ended TIMESTAMPTZ;
BEGIN
 IF p_reason NOT IN ('submitted','timed_out','admin_force') THEN RAISE EXCEPTION 'Invalid submission reason'; END IF;
 SELECT * INTO a FROM public.test_attempts WHERE id=p_attempt_id FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Attempt not found'; END IF;
 IF a.status<>'in_progress' THEN RETURN a; END IF;
 SELECT contest_section INTO section FROM public.tests WHERE id=a.test_id;
 IF section='proof' AND a.working_ended_at IS NULL AND p_reason<>'admin_force' THEN
   IF p_reason='timed_out' AND a.expires_at>clock_timestamp() THEN RETURN a; END IF;
   ended:=LEAST(a.expires_at,clock_timestamp());
   UPDATE public.test_attempts SET working_ended_at=ended,
     working_end_reason=CASE WHEN a.expires_at<=clock_timestamp() THEN 'timed_out' ELSE 'submitted' END,
     expires_at=ended+INTERVAL '15 minutes'
     WHERE id=a.id RETURNING * INTO a;
   INSERT INTO public.test_security_events(attempt_id,user_id,event_type,metadata)
     VALUES(a.id,a.user_id,'proof_upload_window_started',jsonb_build_object('deadline',a.expires_at));
   -- A late reconnect never creates a fresh upload window.
   IF a.expires_at>clock_timestamp() THEN RETURN a; END IF;
 END IF;
 RETURN public.finalize_test_attempt_closed(a.id,p_reason);
END $$;
REVOKE ALL ON FUNCTION public.finalize_test_attempt(UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_test_attempt(UUID,TEXT) TO service_role;

-- Once solving ends, neither deadline edits nor an old frontend may reopen it.
CREATE FUNCTION public.guard_proof_phase_deadline() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF OLD.working_ended_at IS NOT NULL AND
   ROW(NEW.working_ended_at,NEW.working_end_reason,NEW.expires_at,NEW.started_at,NEW.extension_minutes)
   IS DISTINCT FROM ROW(OLD.working_ended_at,OLD.working_end_reason,OLD.expires_at,OLD.started_at,OLD.extension_minutes)
 THEN RAISE EXCEPTION 'Proof upload deadline is locked'; END IF;
 IF OLD.working_ended_at IS NULL AND NEW.working_ended_at IS NOT NULL AND
   (NEW.working_ended_at>LEAST(OLD.expires_at,clock_timestamp()) OR NEW.working_ended_at<OLD.started_at OR
    NEW.expires_at<>NEW.working_ended_at+INTERVAL '15 minutes' OR NEW.working_end_reason IS NULL OR
    NOT EXISTS(SELECT 1 FROM public.tests WHERE id=NEW.test_id AND contest_section='proof'))
 THEN RAISE EXCEPTION 'Invalid proof upload phase'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_proof_phase_deadline BEFORE UPDATE ON public.test_attempts FOR EACH ROW EXECUTE FUNCTION public.guard_proof_phase_deadline();

-- Deadline edits can extend active solving, but cannot reopen finished work or uploads.
CREATE OR REPLACE FUNCTION public.sync_test_deadlines() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 UPDATE public.test_attempts SET expires_at=LEAST(started_at+make_interval(mins=>NEW.duration_minutes+extension_minutes),coalesce(NEW.closes_at,'infinity'::TIMESTAMPTZ))
 WHERE test_id=NEW.id AND status='in_progress' AND working_ended_at IS NULL;
 RETURN NEW;
END $$;

CREATE FUNCTION public.guard_proof_upload_phase() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
DECLARE a public.test_attempts; section TEXT;
BEGIN
 -- Grading-only updates are permitted after final submission.
 IF TG_TABLE_NAME='test_responses' AND TG_OP='UPDATE' THEN
   IF ROW(NEW.attempt_id,NEW.question_id,NEW.response_text,NEW.selected_choice,NEW.file_path,NEW.file_name,NEW.file_mime_type,NEW.answered_at)
   IS NOT DISTINCT FROM ROW(OLD.attempt_id,OLD.question_id,OLD.response_text,OLD.selected_choice,OLD.file_path,OLD.file_name,OLD.file_mime_type,OLD.answered_at) THEN RETURN NEW; END IF;
 END IF;
 SELECT * INTO a FROM public.test_attempts WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.attempt_id ELSE NEW.attempt_id END FOR UPDATE;
 SELECT contest_section INTO section FROM public.tests WHERE id=a.test_id;
 IF section='proof' AND a.working_ended_at IS NULL THEN RAISE EXCEPTION 'Finish the proof round before uploading'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER guard_proof_response_phase BEFORE INSERT OR UPDATE OR DELETE ON public.test_responses FOR EACH ROW EXECUTE FUNCTION public.guard_proof_upload_phase();
CREATE TRIGGER guard_proof_scratch_phase BEFORE INSERT OR UPDATE OR DELETE ON public.test_scratch_files FOR EACH ROW EXECUTE FUNCTION public.guard_proof_upload_phase();

UPDATE public.tests SET security_mode='one_sitting',require_fullscreen=TRUE,block_clipboard=TRUE,
 instructions_latex=replace(instructions_latex,'Only answers and uploads saved to the server before that deadline count. Confirm the saved status of your work. Submission is final; at the deadline the server automatically submits saved work.',CASE WHEN contest_section='proof' THEN 'Stop solving at that deadline. Your separate 15-minute upload window begins then, or immediately if you finish solving early. Only files saved before the upload deadline count. Final submission is permanent; at the upload deadline the server automatically submits saved work.' ELSE 'Only answers and uploads saved to the server before that deadline count. Confirm the saved status of your work. Submission is final; at the deadline the server automatically submits saved work.' END) || E'\n\nSecurity: complete this section in one continuous sitting in the starting browser tab. Fullscreen is required; tab changes, focus changes, and fullscreen exits are recorded for organizer review. Copying and pasting are blocked. The timer starts only after you read the preface, accept the rules, and press Begin test. It keeps running during disconnection or absence.' ||
 CASE WHEN contest_section='proof' THEN E'\n\nProof submission: write your solutions on paper during the timed round. Do not scan or upload during solving. When you finish the round or your solving timer expires, stop working immediately. The problems will be hidden and you have exactly 15 additional minutes to photograph/scan and upload one PDF or image per problem, plus optional scratch work. Combine multiple pages for a problem into one PDF before uploading. You may use other tabs or a scanning app during this upload period solely to submit work already completed. No new mathematical work or edits to solutions are allowed. The upload window starts at the actual end of solving, even if you are offline, and may extend 15 minutes beyond the tournament solving cutoff. Press Submit proofs to finish; otherwise saved uploads submit automatically at the upload deadline.' ELSE E'\n\nComputational submission: save your integer answers and optional scratch work during the timed round. There is no additional answer-editing or scratch-upload time after this section ends.' END
 WHERE contest_section IS NOT NULL;
NOTIFY pgrst, 'reload schema';
COMMIT;
