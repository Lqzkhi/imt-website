-- Apply once after 004. Preserve contest content and existing submissions.
BEGIN;

-- Serialize early-finish retries with the phase transition. Two requests that
-- both observed solving must not turn the second request into final submission.
CREATE FUNCTION public.finish_test_work(p_attempt_id UUID)
RETURNS public.test_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.test_attempts;
BEGIN
 SELECT * INTO a FROM public.test_attempts WHERE id=p_attempt_id FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Attempt not found'; END IF;
 IF a.status<>'in_progress' OR a.working_ended_at IS NOT NULL THEN RETURN a; END IF;
 RETURN public.finalize_test_attempt(a.id,'submitted');
END $$;
REVOKE ALL ON FUNCTION public.finish_test_work(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_test_work(UUID) TO service_role;

-- Expiry ends solving immediately, even if the background worker is delayed.
CREATE OR REPLACE FUNCTION public.sync_test_deadlines() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 UPDATE public.test_attempts SET expires_at=LEAST(started_at+make_interval(mins=>NEW.duration_minutes+extension_minutes),coalesce(NEW.closes_at,'infinity'::TIMESTAMPTZ))
 WHERE test_id=NEW.id AND status='in_progress' AND working_ended_at IS NULL
   AND expires_at>clock_timestamp();
 RETURN NEW;
END $$;

CREATE FUNCTION public.guard_expired_test_extension() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF OLD.expires_at<=clock_timestamp() AND NEW.expires_at>OLD.expires_at
   AND NEW.working_ended_at IS NOT DISTINCT FROM OLD.working_ended_at
 THEN RAISE EXCEPTION 'Attempt closed: expired deadlines cannot be extended'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_expired_test_extension BEFORE UPDATE ON public.test_attempts
FOR EACH ROW EXECUTE FUNCTION public.guard_expired_test_extension();
NOTIFY pgrst, 'reload schema';
COMMIT;
