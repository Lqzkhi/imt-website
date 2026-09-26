BEGIN;
-- Preserve the original file columns for older clients and existing submissions.
ALTER TABLE public.test_responses ADD COLUMN files JSONB NOT NULL DEFAULT '[]'::JSONB;
UPDATE public.test_responses SET files=jsonb_build_array(jsonb_build_object('file_path',file_path,'file_name',file_name,'file_mime_type',file_mime_type)) WHERE file_path IS NOT NULL;

CREATE FUNCTION public.guard_response_files() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
DECLARE a public.test_attempts;
BEGIN
 IF TG_OP='UPDATE' AND NEW.files IS NOT DISTINCT FROM OLD.files THEN RETURN NEW; END IF;
 SELECT * INTO a FROM public.test_attempts WHERE id=NEW.attempt_id FOR UPDATE;
 IF a.status<>'in_progress' OR a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Attempt closed'; END IF;
 IF EXISTS(SELECT 1 FROM public.tests WHERE id=a.test_id AND contest_section='proof') AND a.working_ended_at IS NULL THEN RAISE EXCEPTION 'Finish the proof round before uploading'; END IF;
 IF jsonb_typeof(NEW.files)<>'array' OR jsonb_array_length(NEW.files)>10 THEN RAISE EXCEPTION 'At most 10 proof files per problem'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_response_files BEFORE INSERT OR UPDATE ON public.test_responses FOR EACH ROW EXECUTE FUNCTION public.guard_response_files();

CREATE FUNCTION public.edit_proof_files(p_attempt UUID,p_question UUID,p_file JSONB DEFAULT NULL,p_remove TEXT DEFAULT NULL) RETURNS public.test_responses LANGUAGE plpgsql SET search_path=public AS $$
DECLARE a public.test_attempts; r public.test_responses; attachments JSONB;
BEGIN
 SELECT * INTO a FROM public.test_attempts WHERE id=p_attempt FOR UPDATE;
 IF a.id IS NULL OR a.status<>'in_progress' OR a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Attempt closed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.test_questions WHERE id=p_question AND test_id=a.test_id AND answer_type='file_upload') THEN RAISE EXCEPTION 'Invalid proof question'; END IF;
 SELECT * INTO r FROM public.test_responses WHERE attempt_id=p_attempt AND question_id=p_question;
 attachments=coalesce(r.files,'[]'::JSONB);
 IF p_remove IS NOT NULL THEN
   SELECT coalesce(jsonb_agg(value),'[]'::JSONB) INTO attachments FROM jsonb_array_elements(attachments) WHERE value->>'file_path'<>p_remove;
 ELSIF p_file IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(attachments) WHERE value->>'file_path'=p_file->>'file_path') THEN attachments=attachments||jsonb_build_array(p_file); END IF;
 END IF;
 IF jsonb_array_length(attachments)=0 THEN
   DELETE FROM public.test_responses WHERE id=r.id;
   RETURN NULL;
 END IF;
 INSERT INTO public.test_responses(attempt_id,question_id,files,file_path,file_name,file_mime_type,answered_at)
 VALUES(p_attempt,p_question,attachments,attachments->0->>'file_path',attachments->0->>'file_name',attachments->0->>'file_mime_type',clock_timestamp())
 ON CONFLICT(attempt_id,question_id) DO UPDATE SET files=EXCLUDED.files,file_path=EXCLUDED.file_path,file_name=EXCLUDED.file_name,file_mime_type=EXCLUDED.file_mime_type,answered_at=EXCLUDED.answered_at,grading_status='ungraded',points_awarded=NULL,feedback=''
 RETURNING * INTO r;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.edit_proof_files(UUID,UUID,JSONB,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.edit_proof_files(UUID,UUID,JSONB,TEXT) TO service_role;

-- The organizer already set the live duration to 180 minutes. Match the text.
UPDATE public.tests SET description=replace(description,'2 hours','3 hours'),
 instructions_latex=replace(replace(instructions_latex,'120 minutes','180 minutes'),'2 hours','3 hours')
 WHERE contest_section='computational';
COMMIT;
