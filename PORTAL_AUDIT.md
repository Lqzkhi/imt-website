# Fall 2026 portal audit and implementation

Scope: participant portal, both Round 1 contests, authentication, uploads, deadline handling, integrity reporting, and post-contest grading. Tournament format follows the published [Fall 2026 page](https://www.integratedmath.org/competitions/fall-2026/).

## Changes

| Area | Finding and resulting behavior |
| --- | --- |
| Discovery | Portal was absent from primary navigation; added a contest portal link. The navigation's Register link led to email updates; it now uses the existing Fall registration form. |
| Participant landing | Generic test copy replaced with the actual two-section format, continuous timer explanation, and support/details links. Google sign-in is available after provider configuration. |
| Authoring | Two correctly timed drafts and 25 explicit placeholders are seeded. Publication requires the expected section format, real statements, and valid computational keys. |
| Automatic submission | Expired attempts previously finalized only on requests. Added a once-per-minute database worker, visible worker heartbeat, and immediate database rejection of late content writes. |
| Deadline changes | Per-attempt extensions could exceed the contest cutoff; extensions now cap at closing time. Contest edits synchronize active deadlines in one transaction. |
| Submission races | Final grading previously used separate server writes. Submission now locks the attempt and grades/closes it in a single database transaction. Content writes serialize on the same attempt. |
| Autosave | Saves now run in order; failed saves cannot display “All changes saved.” Navigation flushes numerical input; leaving an active attempt prompts a browser warning. |
| Scratch work | Separate private scratch uploads, up to 10 files per section; format/content checks, owner checks, deadline guards, and admin downloads. |
| Integrity review | Consolidated Fall report with per-section statuses, human-review signals, scheduler health, overdue counts, weighted scores, and CSV export. Large reports fetch paginated data. |
| Proof grading | Dedicated problem-by-problem browser grading queue, optional identity hiding, uploaded image preview/private file opening, rubric, partial credit, feedback, and next-ungraded navigation. |
| Grader concurrency | Grade, attempt total, and audit record update atomically. A stale grade cannot overwrite another grader's newer work. |
| Results | Auto-grades and feedback remain hidden by default. Database guards require closing and complete grading before release. |
| Request validation | Confirmed email required; JSON object/size checks; numerical syntax made consistent with database grading; zero-byte proof uploads rejected. |
| Dependency security | Compatible locked dependency updates resolved seven audit findings, including Astro/Sharp advisories. |
| Deployment | Replaced an incompatible GitHub Pages deployment workflow with test/build/audit CI for the Vercel server application. Canonical site URL corrected. |
| Production scripts | Astro could inline small navigation scripts that the strict CSP would block. Processed scripts now stay external; portal responses disable caching and indexing. |

## Security boundaries and limits

Supabase verifies bearer tokens on every portal API request. Owner-scoped participant routes and administrator membership checks protect service-role database access. Portal tables have RLS with no browser policies; answer keys and scratch rows additionally revoke browser grants. Uploads remain private, paths are owner-scoped, and file signatures are checked. Mutations use database-backed rate limiting and same-origin checks. Existing site headers restrict framing, content sniffing, capabilities, and script sources.

Browser focus/fullscreen/clipboard events can be incomplete or spoofed. They are review context, not proof of cheating. This system cannot establish whether someone used another device, an external assistant, or unauthorized paper materials. Fullscreen and clipboard controls remain configurable rather than being prerequisites for legitimate upload/accessibility workflows. Malware scanning is not implemented; accepted formats and signatures are not a full malware scanner.

The Fall section identifiers currently designate these two contests. Create ordinary tests without these identifiers for smoke tests or future tournaments; a future season should receive a separate tournament/section model rather than reusing the Fall identifiers.

## Verification and rollout

The regression test applies the actual portal migrations to PGlite (PostgreSQL-compatible), substituting fixture Auth/Storage schemas and omitting pgcrypto extension installation. It checks seeded format, atomic submission, duplicate-finalization idempotency, auto-scoring, timeout receipt time, scratch limits, closed-write rejection, access grants, partial-credit grading, stale-grader rejection, audit records, and active deadline synchronization.

See [TEST_PORTAL_SETUP.md](./TEST_PORTAL_SETUP.md) for migrations, Google OAuth, Cron activation, actual-domain acceptance checks, authoring, and post-contest release. Production Auth/Storage/Cron and signed-in contest/grading browser flows require those configured services and separate live validation. No production migration or deployment is implied by a local build.

Local verification completed: Astro check passed with zero errors/warnings; server build passed; SQL regression suite passed; npm audit reported zero vulnerabilities. Participant landing/sign-in/create-account tabs and mobile navigation were inspected in the local browser at desktop and 390px width. Signed-in attempts, proof grading, Google OAuth, hosted Storage, and Cron have not been validated against production.

## September 26 final content

Prepared private import of 25 final statements, integer keys, prior-task solutions, and proof rubrics. Added AMC-style terms with a pre-timer acknowledgement and saved rules snapshot, integer-only UI/API/database enforcement, and safe LaTeX list rendering. Production inspection is underway; hosted import, Cron, Auth, Storage, Google OAuth, and deployment still require live verification.
