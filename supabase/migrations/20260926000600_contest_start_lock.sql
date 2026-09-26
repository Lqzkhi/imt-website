-- Apply after 004/005. Keep simultaneous-section protection without requiring
-- the API service role to lock rows in Supabase's protected auth.users table.
BEGIN;
CREATE OR REPLACE FUNCTION public.guard_fall_single_sitting()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.tests WHERE id=NEW.test_id AND contest_section IS NOT NULL) THEN
  -- All starts for one participant serialize until the inserting transaction
  -- commits. Hash collisions only serialize unrelated participants briefly.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('imt-contest-start:' || NEW.user_id::TEXT, 0));
  IF EXISTS(SELECT 1 FROM public.test_attempts a JOIN public.tests t ON t.id=a.test_id
    WHERE a.user_id=NEW.user_id AND a.test_id<>NEW.test_id AND a.status='in_progress'
      AND t.contest_section IS NOT NULL AND
      (a.expires_at>clock_timestamp() OR (t.contest_section='proof' AND a.working_ended_at IS NULL AND a.expires_at+INTERVAL '15 minutes'>clock_timestamp())))
  THEN RAISE EXCEPTION 'Finish your other contest section before starting this one'; END IF;
 END IF;
 RETURN NEW;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
