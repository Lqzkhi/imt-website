# Test Portal setup

The portal requires a server deployment (Vercel), the Supabase migrations below, and configured Auth. A local build does not apply these changes to the production database.

## 1. Apply the migration

After the proof-upload migration 004 and audit migration 005, apply `supabase/migrations/20260926000600_contest_start_lock.sql`. This fixes contest starts under Supabase's restricted service role without granting access to `auth.users`. Existing installations must apply this follow-up as well; do not rerun migration 004.

Use either option:

- In the Supabase dashboard, open **SQL Editor**, run `supabase/migrations/20260731_test_portal.sql`, then `supabase/migrations/20260731_test_portal_hardening.sql`, then `supabase/migrations/20260926000100_fall_tournament.sql`. Skip migrations already recorded as applied.
- If this repository is linked to the Supabase CLI and its migration history is reconciled, run `supabase db push` from the repository root. The two historical July files share the same date prefix; reconcile their applied history before using the CLI rather than renaming an already-applied production migration. The new Fall migrations use unique timestamps.

The order matters. Apply each migration once through your migration workflow. The Fall migration creates two drafts with 20 computational and 5 proof placeholders; it also replaces submission with atomic database grading, adds scratch files, and guards late content writes.

Enable **Integrations → Cron** in Supabase, then apply `supabase/migrations/20260926000200_fall_tournament_cron.sql`. This installs `imt-auto-submit`, which runs once per minute, even when all browsers are closed. The exact deadline is enforced on every content write; background status processing may follow within a minute (or longer if a large backlog or scheduler outage occurs).

Confirm **Admin workspace → Tournament report** shows a healthy worker before publishing. A missing or stale heartbeat is an actionable setup failure. Check Supabase Cron's job-run history if it is unhealthy. Do not treat the worker as active merely because the migration file exists in Git.

The migration creates:

- test, problem, protected answer-key, attempt, response, administrator, and security-event tables;
- row-level security that denies direct browser access to all portal tables;
- a private `test-submissions` Storage bucket with a 25 MB hard limit and PDF/image MIME restrictions.
- database-backed mutation throttling, attempt accommodations, grade provenance, and an administrator audit log.

Do not make the bucket public and do not add browser-facing SELECT policies to `test_question_keys`.

### Security audit follow-up

After 004, apply `supabase/migrations/20260926000500_audit_deadline_safety.sql` once before deploying the audit fixes. It adds an idempotent finish-solving RPC and prevents expired deadline revival. See [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) for the findings and remaining launch checks.

### Proof upload window update

After the terms migration `20260926000300_fall_contest_terms.sql`, apply `supabase/migrations/20260926000400_proof_upload_window.sql` once. This adds the 15-minute proof upload phase, locks its deadline, and enables Fall fullscreen and clipboard settings. Keep both sections as drafts during preview acceptance. Do not rerun the earlier import or migrations already applied. This update preserves questions, answer keys, previous submissions, and the existing Cron job.

Deploy the matching frontend to Preview. Review the real drafts with administrator preview without consuming attempts. Exercise the full proof workflow using a separate staging database with a disposable contestant account; the shared live database should keep the real Fall contests in draft until launch. Check preface scrolling, timer start, blocked proof/scratch uploads during solving, early finish, automatic transition, saved proof preview, final submission, late upload rejection, and hidden scores. Confirm an upload window is marked separately in administrator attempt review. Local database tests do not establish compatibility with additional legacy production triggers; if Supabase reports an error, preserve that error and resolve it before opening either contest.

## 2. Configure deployment environment variables

Set these in the local `.env` file and in the Vercel project settings:

```text
PUBLIC_SUPABASE_URL
PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

`SUPABASE_SERVICE_ROLE_KEY` must remain server-only. Never rename it with a `PUBLIC_` prefix or expose it in client code.

## 3. Configure Supabase Auth

In **Authentication → Providers**, enable Email/password authentication.

In **Authentication → URL Configuration**:

- Set the production Site URL.
- Add `https://YOUR-DOMAIN/test-portal` as an allowed redirect URL.
- For local development, also add `http://localhost:4321/test-portal` and `http://127.0.0.1:4321/test-portal`.

The portal supports account creation, email confirmation, sign-in, sign-out, and password recovery. Enable email confirmation and set reasonable Supabase Auth rate limits; configure SMTP so confirmation and recovery messages are delivered reliably.

Account sign-in uses email and is separate from the public tournament registration form; use the same email for both.

## 4. Grant the first administrator

Create/sign in to the desired account at `/test-portal`, then run this in the Supabase SQL Editor after replacing the email:

```sql
INSERT INTO public.test_admins (user_id)
SELECT id
FROM auth.users
WHERE lower(email) = lower('admin@example.com')
ON CONFLICT (user_id) DO NOTHING;
```

Refresh `/test-portal`. The **Admin workspace** button should appear. This SQL step is only needed to bootstrap the first administrator.

After the first administrator exists, add or remove subsequent administrators in **Admin workspace → Administrators**. The target email must already have a Test Portal account. The final administrator cannot remove themselves, which prevents accidental lockout.

## 5. First test smoke check

1. Create a draft in **Test Portal → Admin workspace**.
2. Add one numerical problem and one multiple-choice problem, including both answer keys.
3. Add a file-upload problem if manual grading is needed.
4. Use **Preview**; this does not create an attempt or reveal answer keys in the preview payload.
5. Set opening/closing times, duration, security mode, and publish the test.
6. Sign in with a non-admin participant account, complete the test, and verify the submission in the admin report.
7. For a file response, open its private signed link and assign a manual grade.
8. Confirm that **Administrator activity** shows the authoring and grading changes, and test **Add time** on an active attempt.

## 6. Verify before deployment

```text
npm run check
npm test
npm run build
npm audit
```

`npm run build` includes the heap size required by the current Vercel adapter. GitHub Actions verifies tests/build/audit; it does not deploy this server application to GitHub Pages. Configure Vercel's Git integration and production environment variables for deployment.

## Fall 2026 authoring and deadlines

The migration seeds **Fall 2026 IMT · Computational** (120 minutes, 20 numerical answers) and **Fall 2026 IMT · Proof** (270 minutes, 5 uploads, 7 points each). Both are drafts, with results hidden. After migration 004, Fall fullscreen and clipboard blocking default on during solving and lift during proof uploads. Review device support and arrange accommodations before contestants start; focus and visibility events are recorded. Confirm and expand the independent-work/resource rules in the instructions before publishing.

1. Open each draft in Admin workspace; edit its placeholder problems. Saving a real statement clears its placeholder flag. Add computational answer keys and proof grading notes/rubrics.
2. Preview each section and check mathematical rendering, ordering, points, and accepted file types. Both sections require their full expected problem count before publication.
3. The default window is September 26, 2026 at 00:00 Eastern through the end of October 10: the exclusive cutoff is **October 11, 2026 at 00:00 America/New_York**, or **2026-10-11T04:00:00Z**. Admin datetime inputs and contestant cards display local time. Verify the time zone before saving.
4. To extend the tournament, edit **Auto-submit cutoff** on both contests. Existing active deadlines recompute in the database without restarting personal timers. An individual accommodation cannot exceed the contest cutoff. Submitted/timed-out attempts remain closed; an extension must happen before the affected attempts expire.
5. Publish after every statement/key is ready. Placeholder publication is blocked. Problems and keys lock after the first attempt. Do not use real competitor accounts for pre-contest smoke tests; create a separate disposable test instead.

Each student gets one attempt per section; they can take the sections separately and in either order. The timer continues through refreshes and outages. A lost one-sitting tab requires an administrator unlock from the attempt review page. Proof answers accept private PDF/images per problem (default 10 MB, configurable to 25 MB); supplementary scratch paper accepts up to 10 files per section, each at most 3 MB to remain below the server upload limit. Scratch files are never scored as proof answers.

## Post-contest grading and result release

Computational answers auto-grade on submission or timeout. The API omits scores and feedback while **Show results** is off, including after submission. No answer keys are sent to competitors.

Use **Admin workspace → Grade proofs** (`/test-portal/admin/grading`) instead of working in Supabase. Select a problem to grade it across submitted competitors, optionally hide identity, open the private proof file (images also display inline), consult the problem's grading notes, and assign 0–7 points plus feedback. **Save & next ungraded** advances the queue. Turn off **Ungraded only** to revisit a grade. Empty proof answers count as zero; scratch uploads do not substitute for an answer. Grades record the administrator and timestamp; stale saves are rejected when another grader has changed the response.

The full attempt review page includes all answers, private scratch downloads, security events, grade overrides, deadline extensions, and session unlocks. Grading and attempt-score updates occur in one transaction. The administrator audit log records each change.

Use **Tournament report** (`/test-portal/admin/overview`) to check outstanding attempts, review integrity signals, inspect the auto-submit worker, and export CSV. A combined percentage is calculated only when both sections are fully graded: `50 × computational_score/computational_max + 50 × proof_score/proof_max`. Review scores and ties before deciding qualification or awards; the report does not automatically disqualify competitors or choose a cutoff.

After the contest closes and all submissions for a section are fully graded, enable **Show results** in that section's settings and save. Database guards reject early release and incomplete grading. Release both sections when the team is ready. Feedback and per-problem points become visible in each competitor's submission view; a public leaderboard or award announcement is a separate decision.

## Production acceptance check

Before opening the real contests, verify with an admin and a separate participant account on the deployed domain:

- Email confirmation and password recovery complete successfully.
- Drafts and protected keys are inaccessible to students; another participant cannot open your attempt or upload to it.
- Refresh preserves the one-sitting tab; a different tab is locked; admin unlock restores access.
- Both proof and scratch uploads save, can be removed before submission, and appear in the admin review after submission. Invalid content and oversized files fail.
- A short disposable test auto-submits with all browser tabs closed; the worker heartbeat and timeout event appear. Post-deadline answers and scratch writes are rejected.
- Proof partial credit, feedback, concurrent grader conflict, and the CSV report work. Competitor scores remain hidden until release.
- Mobile/keyboard/fullscreen workflows work with actual supported devices; focus events are contextual signals, not misconduct verdicts.

These require the real Supabase Auth, Storage, and Cron configuration. The local PGlite regression suite verifies the SQL logic with fixture Auth/Storage schemas; it does not emulate hosted Auth, Storage, or the cron scheduler.

## Security notes

- Student endpoints explicitly omit answer-key fields. Numerical and multiple-choice grading occurs only in server code using the service role.
- One-sitting attempts use a non-pausable server deadline and a hashed, tab-scoped session token. An administrator can unlock a lost tab from the attempt review page.
- Take-home attempts can resume, but their personal duration and the test closing time continue to run.
- Fullscreen, focus/visibility, and blocked clipboard events are available in each attempt review. These events are context for human review, not automatic misconduct findings.
- Uploads use short-lived signed upload URLs scoped to a participant, attempt, and problem. The server checks size, extension, MIME metadata, and file signatures before linking an answer. Admin downloads also use expiring signed URLs.
- Participants can remove or replace an upload while an attempt is active; the superseded private Storage object is deleted by the server.
- All authenticated mutations are rate-limited in PostgreSQL, so the limit remains effective across serverless instances.
- Deadline extensions, grade overrides, administrator access changes, and test-authoring changes record the acting administrator and are visible in the activity view.
- Site-wide headers enforce clickjacking protection, MIME sniffing protection, a restrictive permissions policy, and a Test Portal Content Security Policy that disallows inline scripts.

## Final problem import and contest terms

Final statements, integer keys, solutions, grading rubrics, and SQL are prepared in `.portal-private/` (gitignored). Do not commit these files or include them in a public build. Run `node scripts/prepare-contest-import.mjs` to regenerate `.portal-private/import-fall-2026.sql`. Apply all Fall migrations including `20260926000300_fall_contest_terms.sql`, then run this private import in the matching Supabase project. The import refuses contests with attempts or published status, rolls back on failure, preserves timing settings, and leaves both contests as drafts. Preview and perform production acceptance checks before publishing.

The preamble requires integer extractions, defines floor and reduced-fraction sums, and imposes no three-digit limit. AMC-style terms prohibit calculators, computer algebra, AI, reference materials, online searches, and outside help; scratch paper and writing/drawing tools are permitted. New competitors accept the current rules before starting. The API checks their rules version; the database records the acceptance time and exact rules snapshot, visible in administrator attempt review. Proof 5 uses a LaTeX enumerate environment, rendered as a numbered list by the portal.

Production compatibility: the Fall migration reuses matching untouched drafts already in the live portal, preserves the existing composite submission RPC return type and source tracking, and sets the requested opening/closing window on those drafts. The Cron migration updates the existing test-portal-autosubmit job when present; otherwise it creates imt-auto-submit. Keep existing integrity triggers and prior contest data.
