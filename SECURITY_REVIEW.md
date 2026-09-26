# Website security and release review — 2026-09-26

Decision: HOLD production rollout. Code fixes are committed to the preview branch `codex/proof-upload-window`; this review does not certify that the application is bug-free.

## Findings fixed in this review

| Finding | Fix |
| --- | --- |
| Starting a contest failed under Supabase's service role because the simultaneous-section guard locked `auth.users`, which that role cannot update. | Migration 006 replaces the auth-table lock with a per-participant transaction advisory lock, preserving section exclusion without granting auth-table privileges. |
| A lost start response discarded the browser's one-sitting session token. | Persist the token before starting and reuse it on retries and reloads. |
| Navigating while a numerical save was pending could compare against stale server state and lose the latest edit. | Wait for the queued save before comparing and flushing the current input. |
| Failed proof/scratch uploads could leave an “All changes saved” indicator and allow submission. | Retain failure state and require a successful retry before manual submission. Server timeout still submits whatever actually saved. |
| Expired statements remained visible if the submission request failed offline. | Hide the statement and disable the workspace immediately at the local deadline while retrying the server transition. Server/database deadline enforcement remains authoritative. |
| Concurrent finish-solving requests could treat the second request as final proof submission. | New `finish_test_work` RPC locks the attempt and returns the existing upload phase on retries. |
| Editing contest deadlines could revive expired, not-yet-processed attempts. | Synchronize only unexpired solving attempts and reject direct extensions after expiry. |
| Tournament overview counted permitted proof-upload tab changes as integrity review signals. | Exclude server-labelled upload events from summary counts; retain raw events in attempt review. |
| Diagnostic pages containing personal results lacked explicit cache/index restrictions. | Extend private/no-store and noindex headers to diagnostics, account, and API routes. |
| JSON body validation buffered the whole request before checking its size. | Limit streamed bytes, including requests without Content-Length. |
| Development host checks were disabled and some environment filenames were not ignored. | Restore Astro host checking and ignore `.env.*` except the example file. |

## Checks and limits

- Automated database tests apply repository migrations to PGlite, with fixture Auth/Storage schemas. These cover timers, submission, proof phases, grading, permissions, scratch limits, expired edits, and repeated finish-work calls. They do not verify every extra trigger in the hosted database.
- Request tests cover exact-origin CSRF rejection and bounded chunked/multibyte JSON bodies.
- Headless Chromium exercised the actual attempt-page script with mocked authentication/API/storage: pending numerical saves, proof/scratch gating, transition to uploads, statement hiding, and failed-upload submission blocking. This is client behavior verification, not hosted Storage or signed-in acceptance.
- Initial audit verification: all eight automated tests passed; Astro checked 77 files with zero errors, warnings, or hints; the Vercel-adapter production build passed.
- Local rehearsal follow-up: all nine automated tests pass, including reproducing the start failure under `service_role` without auth-table access and verifying the migration fixes it while keeping overlap blocked during solving and proof uploads. Real local Supabase HTTP requests pass computational start/load/submit, overlapping-section rejection, and proof start/upload-phase/submit. Production application of migration 006 and hosted acceptance remain outstanding.
- npm's live bulk-advisory endpoint returned no advisories for the installed lockfile package versions. This does not prove absence of unknown vulnerabilities.
- Live read-only checks: homepage, Fall page, portal, diagnostic landing return 200; unauthenticated `/api/test-portal/me` returns 401; foreign-origin start returns 403; `.env` and private contest bundle URLs return 404. The new grading and tournament overview routes still return 404 on production, confirming that the old release is live.
- Portal APIs were reviewed for verified bearer authentication, owner/admin checks, same-origin mutation checks, private file links, deadline enforcement, hidden results, and answer-key separation. No credentials or unreleased contest content were added to tracked files.

## Required before deployment and contest launch

1. Apply `supabase/migrations/20260926000500_audit_deadline_safety.sql` once after 004, then `supabase/migrations/20260926000600_contest_start_lock.sql`. The owner confirmed 004 is already applied; do not rerun it. The new code depends on the new RPC. Migration 006 is applied to the local rehearsal database only. Validate these migrations with the actual hosted triggers.
2. Configure custom SMTP and verify real confirmation and password-recovery delivery, then enable confirmation. The owner confirmed email configuration is unfinished. An auto-confirmed account's `email_confirmed_at` is not evidence that the mailbox was verified.
3. Run authenticated staging acceptance with separate organizer/contestant accounts: owner/admin isolation, real proof/scratch upload/download, late file rejection, proof grading and hidden results, lost-response recovery, browser-closed timeout, and the 15-minute upload period. Check the Cron heartbeat.
4. Deploy the matching website release to the correct Vercel production project and inspect the actual domain. The domain currently runs older code. Keep the real contests as drafts through acceptance and publish only after the checks pass.

## Additional security measures

- Enable MFA for organizer infrastructure accounts (Supabase, Vercel, GitHub); add an enrollment/recovery flow before requiring MFA for portal administrators.
- Set Auth rate limits and consider CAPTCHA for signup/recovery abuse. Add edge/WAF limits for anonymous diagnostic creation and high-cost read requests; current portal mutation limits do not cover all anonymous diagnostic traffic.
- Add upload malware scanning/quarantine. Current MIME/signature checks are not a malware scanner. Signed upload capabilities can outlive the contest deadline; database linking rejects late submissions, but unused objects need lifecycle cleanup and storage monitoring.
- Configure alerts for failed/stale Cron jobs, server errors, and unusual upload volume; verify backups and restoration before the tournament.
- Browser fullscreen, clipboard blocking, and focus logs cannot establish whether contestants used other devices or outside help. Review signals manually.

References: [Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod), [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [signed upload URLs](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl).

