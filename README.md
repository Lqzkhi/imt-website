# Integrated Math website

Astro server application for Integrated Math, deployed with the Vercel adapter. The Fall 2026 contest portal lives at `/test-portal`.

Read [TEST_PORTAL_SETUP.md](./TEST_PORTAL_SETUP.md) for Supabase migrations, Auth/Google setup, the submission worker, problem authoring, and post-contest grading. [PORTAL_AUDIT.md](./PORTAL_AUDIT.md) records the Fall portal changes and verification limits.

```sh
npm ci
npm run dev
npm test
npm run verify
npm audit
```

Copy `.env.example` to `.env` and configure the project values. Keep the Supabase service-role key server-only. The database regression suite uses a local PostgreSQL-compatible runtime and does not require production credentials.

The two Fall contests are seeded as drafts. Replace all placeholder statements and computational answer keys before publication. Admin workspace provides proof grading, private scratch downloads, integrity review, deadline editing, score exports, and controlled result release.

GitHub Actions runs verification. Configure Vercel's Git integration and environment variables to deploy; GitHub Pages cannot host this application's authenticated server APIs. Database migrations and Cron activation are separate from deploying the website.
