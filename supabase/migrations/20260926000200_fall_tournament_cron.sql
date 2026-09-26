-- Enable Supabase Cron under Integrations before applying if pg_cron is unavailable.
CREATE EXTENSION IF NOT EXISTS pg_cron;
-- cron.schedule updates the existing named job; reuse the live job rather than running two workers.
SELECT cron.schedule(CASE WHEN EXISTS(SELECT 1 FROM cron.job WHERE jobname='test-portal-autosubmit') THEN 'test-portal-autosubmit' ELSE 'imt-auto-submit' END, '* * * * *', 'SELECT public.submit_expired_test_attempts();');
