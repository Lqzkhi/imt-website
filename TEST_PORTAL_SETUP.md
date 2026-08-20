# Test Portal setup

The application code is complete, but the database migration must be applied to the Supabase project before the portal can load tests.

## 1. Apply the migration

Use either option:

- In the Supabase dashboard, open **SQL Editor**, run `supabase/migrations/20260731_test_portal.sql`, then run `supabase/migrations/20260731_test_portal_hardening.sql`.
- If this repository is linked to the Supabase CLI, run `supabase db push` from the repository root.

The order matters: the hardening migration extends the tables created by the base migration. Both migrations are idempotent enough for the intended one-time deployment, but they should still be tracked and applied only through the normal migration workflow.

The migration creates:

- test, problem, protected answer-key, attempt, response, administrator, and security-event tables;
- row-level security that denies direct browser access to all portal tables;
- a private `test-submissions` Storage bucket with a 25 MB hard limit and PDF/image MIME restrictions.
- database-backed mutation throttling, attempt accommodations, grade provenance, and an administrator audit log.

Do not make the bucket public and do not add browser-facing SELECT policies to `test_question_keys`.

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

The portal supports account creation, email confirmation, sign-in, sign-out, and password recovery.

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
npm run build
npm audit
```

`npm run build` includes the heap size required by the current Vercel adapter. A clean install currently audits with zero known vulnerabilities.

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
