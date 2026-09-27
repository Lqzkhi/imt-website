BEGIN;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS disqualified_at TIMESTAMPTZ;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS disqualified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS disqualification_reason TEXT NOT NULL DEFAULT '';
CREATE OR REPLACE FUNCTION public.set_attempt_disqualification(p_attempt_id UUID,p_admin_id UUID,p_disqualified BOOLEAN,p_reason TEXT)
RETURNS public.test_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $dq$
DECLARE a public.test_attempts;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.test_admins WHERE user_id=p_admin_id) THEN RAISE EXCEPTION 'Administrator required'; END IF;
 IF p_disqualified IS NULL OR p_reason IS NULL OR char_length(trim(p_reason))<5 OR char_length(p_reason)>2000 THEN RAISE EXCEPTION 'A reason of 5 to 2000 characters is required'; END IF;
 SELECT * INTO a FROM public.test_attempts WHERE id=p_attempt_id FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Attempt not found'; END IF;
 IF p_disqualified AND a.status='in_progress' THEN SELECT * INTO a FROM public.finalize_test_attempt(a.id,'admin_force'); END IF;
 UPDATE public.test_attempts SET disqualified_at=CASE WHEN p_disqualified THEN clock_timestamp() ELSE NULL END,
 disqualified_by=CASE WHEN p_disqualified THEN p_admin_id ELSE NULL END,
 disqualification_reason=CASE WHEN p_disqualified THEN trim(p_reason) ELSE '' END WHERE id=a.id RETURNING * INTO a;
 INSERT INTO public.test_admin_audit_log(admin_user_id,action,test_id,attempt_id,metadata)
 VALUES(p_admin_id,CASE WHEN p_disqualified THEN 'attempt_disqualified' ELSE 'attempt_reinstated' END,a.test_id,a.id,jsonb_build_object('reason',trim(p_reason)));
 RETURN a;
END $dq$;
REVOKE ALL ON FUNCTION public.set_attempt_disqualification(UUID,UUID,BOOLEAN,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_attempt_disqualification(UUID,UUID,BOOLEAN,TEXT) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
