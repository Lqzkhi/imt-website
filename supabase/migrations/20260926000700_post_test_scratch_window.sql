-- Scratch work is supplementary: 30 minutes from the actual end of solving.
-- Answer deadlines and the separate 15-minute proof-answer phase are unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION public.scratch_upload_deadline(a public.test_attempts)
RETURNS TIMESTAMPTZ LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE
   WHEN a.working_ended_at IS NOT NULL THEN a.working_ended_at + INTERVAL '30 minutes'
   WHEN a.status <> 'in_progress' AND a.submitted_at IS NOT NULL
     THEN LEAST(a.submitted_at,a.expires_at) + INTERVAL '30 minutes'
   ELSE NULL END;
$$;
REVOKE ALL ON FUNCTION public.scratch_upload_deadline(public.test_attempts) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scratch_upload_deadline(public.test_attempts) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_scratch_upload_window()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
DECLARE a public.test_attempts; target UUID; deadline TIMESTAMPTZ; total INTEGER;
BEGIN
 target:=CASE WHEN TG_OP='DELETE' THEN OLD.attempt_id ELSE NEW.attempt_id END;
 SELECT * INTO a FROM public.test_attempts WHERE id=target FOR UPDATE;
 IF a.id IS NULL THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RAISE EXCEPTION 'Attempt not found';
 END IF;
 deadline:=public.scratch_upload_deadline(a);
 IF deadline IS NULL THEN RAISE EXCEPTION 'Scratch uploads open after solving ends'; END IF;
 IF deadline<=clock_timestamp() THEN RAISE EXCEPTION 'Scratch upload window closed'; END IF;
 IF TG_OP<>'DELETE' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.attempt_id,NEW.file_path) IS DISTINCT FROM ROW(OLD.attempt_id,OLD.file_path)
     THEN RAISE EXCEPTION 'Scratch file ownership cannot change'; END IF;
   IF NEW.file_path NOT LIKE a.user_id::TEXT || '/' || a.id::TEXT || '/scratch/%'
     THEN RAISE EXCEPTION 'Scratch file belongs to another attempt'; END IF;
   IF NEW.size_bytes>3145728 THEN RAISE EXCEPTION 'Scratch files must be at most 3 MB'; END IF;
 END IF;
 IF TG_OP='INSERT' THEN
   SELECT count(*) INTO total FROM public.test_scratch_files WHERE attempt_id=target;
   IF total>=10 THEN RAISE EXCEPTION 'At most 10 scratch files per attempt'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS guard_test_scratch_write ON public.test_scratch_files;
DROP TRIGGER IF EXISTS guard_proof_scratch_phase ON public.test_scratch_files;
CREATE TRIGGER guard_test_scratch_write BEFORE INSERT OR UPDATE OR DELETE ON public.test_scratch_files
FOR EACH ROW EXECUTE FUNCTION public.guard_scratch_upload_window();

-- Update the known earlier rules, leaving accepted attempt snapshots untouched.
UPDATE public.tests SET instructions_latex =
 replace(replace(replace(replace(replace(instructions_latex,
 'Save numerical answers and upload optional scratch work before your deadline.',
 'Save numerical answers before your solving deadline. Upload scratch work only after solving ends.'),
 'plus optional scratch work.', 'with scratch work using its separate deadline.'),
 'Computational submission: save your integer answers and optional scratch work during the timed round. There is no additional answer-editing or scratch-upload time after this section ends.',
 'Computational submission: save your integer answers during solving. Answers lock when you submit or the timer expires. Scratch work can be uploaded only afterward.'),
 'Only answers and uploads saved to the server before that deadline count.',
 'Only answers saved before their answer deadline count. Scratch work has a separate deadline.'),
 'No extra upload time follows this section.', 'Scratch uploads open only after solving ends.')
 || E'\n\nScratch-paper uploads: optional supporting work may be uploaded only during the 30 minutes immediately after solving ends, whether you finish early or your solving timer expires. This deadline does not restart when you reconnect or submit proofs. Up to 10 PDF or image files, 3 MB each. Scan or photograph only work already completed; no new solving is allowed. You may leave fullscreen and use other tabs or a scanning app during uploads. Scratch work is not a proof answer: proof answers still have their separate 15-minute upload deadline. You may return to your submitted attempt to upload scratch work before its deadline.'
WHERE contest_section IS NOT NULL;
NOTIFY pgrst, 'reload schema';
COMMIT;
