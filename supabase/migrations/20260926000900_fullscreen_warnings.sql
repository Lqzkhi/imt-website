-- Count only exits reported after this policy is deployed; never retroactively lock attempts.
BEGIN;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS fullscreen_warnings INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS security_locked_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION public.record_fullscreen_exit(p_attempt_id UUID, p_event_id UUID)
RETURNS public.test_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.test_attempts; t public.tests;
BEGIN
 SELECT * INTO a FROM public.test_attempts WHERE id=p_attempt_id FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Attempt not found'; END IF;
 SELECT * INTO t FROM public.tests WHERE id=a.test_id;
 IF p_event_id IS NULL THEN RAISE EXCEPTION 'Event ID required'; END IF;
 IF a.status<>'in_progress' OR a.working_ended_at IS NOT NULL OR a.expires_at<=clock_timestamp()
   OR t.security_mode<>'one_sitting' OR NOT t.require_fullscreen THEN RETURN a; END IF;
 IF EXISTS(SELECT 1 FROM public.test_security_events WHERE attempt_id=a.id AND event_type='fullscreen_exited'
   AND metadata->>'event_id'=p_event_id::TEXT) THEN RETURN a; END IF;
 IF a.security_locked_at IS NOT NULL THEN RETURN a; END IF;
 UPDATE public.test_attempts SET fullscreen_warnings=fullscreen_warnings+1,
   security_locked_at=CASE WHEN fullscreen_warnings+1>=3 THEN clock_timestamp() ELSE NULL END
   WHERE id=a.id RETURNING * INTO a;
 INSERT INTO public.test_security_events(attempt_id,user_id,event_type,metadata)
 VALUES(a.id,a.user_id,'fullscreen_exited',jsonb_build_object('event_id',p_event_id,'phase','solving',
   'warning_count',a.fullscreen_warnings,'locked',a.security_locked_at IS NOT NULL));
 RETURN a;
END $$;
REVOKE ALL ON FUNCTION public.record_fullscreen_exit(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_fullscreen_exit(UUID,UUID) TO service_role;
CREATE OR REPLACE FUNCTION public.guard_security_locked_response()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $guard$
DECLARE a public.test_attempts; target UUID;
BEGIN
 target:=CASE WHEN TG_OP='DELETE' THEN OLD.attempt_id ELSE NEW.attempt_id END;
 SELECT * INTO a FROM public.test_attempts WHERE id=target FOR UPDATE;
 IF a.status='in_progress' AND a.security_locked_at IS NOT NULL THEN RAISE EXCEPTION 'Attempt locked after 3 fullscreen warnings'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $guard$;
CREATE TRIGGER guard_security_locked_response BEFORE INSERT OR DELETE OR UPDATE OF response_text,selected_choice,file_path,file_name,file_mime_type,files ON public.test_responses
FOR EACH ROW EXECUTE FUNCTION public.guard_security_locked_response();
NOTIFY pgrst,'reload schema';
COMMIT;
