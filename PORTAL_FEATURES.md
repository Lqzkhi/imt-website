# Fall 2026 portal walkthrough

The portal is at [integratedmath.org/test-portal](https://www.integratedmath.org/test-portal). The two Fall sections have separate attempts and timers. Tournament registration remains separate from portal account creation; competitors should use the same email for both.

## Competitor flow

1. Sign in, create an email account, or request password recovery. Google sign-in appears only after its provider is configured and enabled in the deployment.
2. Open a published section, read the rules and problem-format preamble, and acknowledge the terms before starting the timer. The portal saves the accepted rules and acceptance time.
3. Complete the computational section's 20 integer extractions in two hours, or the proof section's five written problems in four and a half hours. Each is one continuous sitting; the server enforces the earlier of the personal deadline and the contest cutoff.
4. Computational answers save in order. The save indicator reports pending or failed writes. Integers have no three-digit limit; decimal, fractional, and scientific-notation answers are rejected. The problem tells the competitor which integer to extract.
5. Upload a PDF or supported image for each proof. Separate scratch uploads are available in either section: up to ten files, each up to 3 MB. Scratch work is supplementary and is not automatically graded.
6. Submit and receive a submission receipt. Closed attempts cannot be edited. The computational section grades automatically, but neither scores nor proof feedback are shown until the organizer releases results.

The rules prohibit calculators, computer algebra, AI, outside assistance, reference materials, and online searches. Scratch paper and writing/drawing tools are allowed. Proof 5's two conditions display as a numbered list.

## Organizer flow

Sign in with an account listed as a portal administrator. The portal exposes administrator links only to those accounts; the API independently verifies membership.

| Task | Where and how |
| --- | --- |
| Publish or edit contests | Open the administrator test list and a section's settings. Review statements, timing, and rules before publishing. Publication requires complete statements and computational keys. |
| Change the October 10 cutoff | Edit the section's closing date/time and save. Repeat for the other section if both should change. Active attempt deadlines synchronize and remain capped by the cutoff. An extension does not reopen an already submitted or timed-out attempt. |
| Inspect submissions | Open an attempt from a section's submissions list. Review answers, private proof and scratch files, timing, accepted rules, and security events. |
| Grade proofs | Open [Proof grading](https://www.integratedmath.org/test-portal/admin/grading). Select a problem, filter ungraded submissions, optionally hide identities, open the private proof, and apply the supplied rubric with 0–7 points and feedback. Save and move to the next submission. |
| Resolve a grader conflict | Refresh and review the saved grade. A stale browser cannot silently overwrite another grader's newer work. |
| Handle an interrupted sitting | Use the attempt review's session unlock or deadline extension controls. Changes record the acting administrator. |
| Check readiness and integrity | Open [Tournament report](https://www.integratedmath.org/test-portal/admin/overview). Review outstanding attempts, event counts, overdue attempts, worker heartbeat, and grades. Export the CSV for organizer records. |
| Release scores | After the section closes and all submissions are graded, enable Show results in its settings. The database rejects premature release. Release the second section separately when ready. |

The tournament report calculates the combined percentage with 50% weight for each fully graded section. It does not decide qualification, awards, or misconduct findings.

## Automatic submission and privacy

The database checks deadlines on every content write, even if a browser clock is wrong or the competitor has closed the page. A once-per-minute worker closes expired attempts and grades computational answers. Its heartbeat and overdue count appear in the tournament report.

Answer keys and grading notes stay on the server. Proof and scratch files are in private Storage with short-lived download links. Participant endpoints restrict access to the signed-in owner's attempts; administrators can review submissions. Scores and feedback remain hidden until release. Rate limits, session locks, request checks, grade audit records, and database protections operate together.

Focus, fullscreen, and clipboard events are review signals. They cannot prove outside assistance or identify another device. Uploaded files receive format and signature checks, but the portal does not perform malware scanning.

## Verification status

See [PORTAL_AUDIT.md](./PORTAL_AUDIT.md) for findings and rollout evidence, and [TEST_PORTAL_SETUP.md](./TEST_PORTAL_SETUP.md) for configuration and the production acceptance checklist. A feature's implementation should not be confused with a completed live acceptance check.
