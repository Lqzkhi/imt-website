# Fall 2026 portal walkthrough

The portal is at [integratedmath.org/test-portal](https://www.integratedmath.org/test-portal). The two Fall sections have separate attempts and timers. Tournament registration remains separate from portal account creation; competitors should use the same email for both.

## Competitor flow

1. Sign in with email, create an email account, or request password recovery.
2. Open a published section, scroll through the full rules and problem-format preamble, and acknowledge the terms before starting the timer. The portal saves the accepted rules and acceptance time.
3. Complete the computational section's 20 integer extractions in three hours, or the proof section's five written problems in four and a half hours. Each is one continuous sitting; simultaneous Fall sections are blocked. The server enforces the earlier of the personal deadline and the contest cutoff.
4. Computational answers save in order. The save indicator reports pending or failed writes. Integers have no three-digit limit; decimal, fractional, and scientific-notation answers are rejected. The problem tells the competitor which integer to extract.
5. Write proofs on paper during solving. Upload controls stay disabled until solving ends. Press **Finish solving · begin uploads**, or let the solving timer expire: the statements are hidden and a separate 15-minute upload window begins. Select multiple PDFs or supported images together, up to ten files per problem; check each using **Open saved proof** and remove individual attachments if needed. Stop all mathematical work during this window. It starts at the actual end of solving even when offline, and can extend 15 minutes beyond the tournament solving cutoff.
6. Scratch uploads open only after solving ends, for 30 minutes in both sections. Upload up to ten PDF/image files, each up to 3 MB, during the proof upload phase or from the submitted-attempt page. The deadline starts at actual solving completion, including early finish or offline timeout; submitting proofs does not restart it. Scratch work is supplementary, never a replacement for a proof answer, and does not extend answer deadlines. Scanning/tab changes after solving are not solving-period integrity flags.
7. Submit and receive a submission receipt. Closed attempts cannot be edited. The computational section grades automatically, but neither scores nor proof feedback are shown until the organizer releases results.

The rules prohibit calculators, computer algebra, AI, outside assistance, reference materials, and online searches. Scratch paper and writing/drawing tools are allowed. Proof 5's two conditions display as a numbered list.

## Organizer flow

Sign in with an account listed as a portal administrator. The portal exposes administrator links only to those accounts; the API independently verifies membership.

| Task | Where and how |
| --- | --- |
| Publish or edit contests | Open the administrator test list and a section's settings. Review statements, timing, and rules before publishing. Publication requires complete statements and computational keys. |
| Change the October 10 cutoff | Edit the section's closing date/time and save. Repeat for the other section if both should change. Active attempt deadlines synchronize and remain capped by the cutoff. An extension does not reopen an already submitted or timed-out attempt or extend a proof upload window. |
| Inspect submissions | Open an attempt from a section's submissions list. Review answers, private proof and scratch files, timing, accepted rules, and security events. |
| Grade proofs | Open [Proof grading](https://www.integratedmath.org/test-portal/admin/grading). Select a problem, filter ungraded submissions, optionally hide identities, open the private proof, and apply the supplied rubric with 0–7 points and feedback. Save and move to the next submission. |
| Resolve a grader conflict | Refresh and review the saved grade. A stale browser cannot silently overwrite another grader's newer work. |
| Handle an interrupted sitting | Use the attempt review's session unlock or deadline extension controls. Changes record the acting administrator. |
| Check readiness and integrity | Open [Tournament report](https://www.integratedmath.org/test-portal/admin/overview). Review outstanding attempts, event counts, overdue attempts, worker heartbeat, and grades. Export the CSV for organizer records. |
| Release scores | After the section closes and all submissions are graded, enable Show results in its settings. The database rejects premature release. Release the second section separately when ready. |

The tournament report calculates the combined percentage with 50% weight for each fully graded section. It does not decide qualification, awards, or misconduct findings.

## Automatic submission and privacy

The database checks deadlines on every content write, even if a browser clock is wrong or the competitor has closed the page. A once-per-minute worker closes expired attempts and grades computational answers. Its heartbeat and overdue count appear in the tournament report.

Answer keys and grading notes stay on the server. Proof and scratch files are in private Storage with short-lived download links. Participant endpoints restrict access to the signed-in owner's attempts; administrators can review submissions. Scores and feedback remain hidden until release. Rate limits, session locks, request checks, grade audit records, and database protections operate together. Fall defaults require fullscreen and block copy/paste during solving. Each fullscreen exit during solving counts as one warning. The first and second exits cover the workspace with a prominent return prompt; the third locks the attempt on the server until an administrator unlocks it. The timer keeps running. Unlocking resets the warning count; past events stay in the review history. Prominent notices require a laptop or desktop before beginning. Browsers control fullscreen exits, so the site cannot cancel Escape or reliably prevent opening another tab. Supported browsers also prevent duplicate attempt tabs with an exclusive browser lock. During proof uploads, fullscreen and clipboard restrictions are lifted and security events carry an upload-phase label. A preface scroll gate confirms that the whole preface was displayed; it cannot establish comprehension.

Focus, fullscreen, and clipboard events are review signals. They cannot prove outside assistance or identify another device. Uploaded files receive format and signature checks, but the portal does not perform malware scanning.

## Verification status

See [PORTAL_AUDIT.md](./PORTAL_AUDIT.md) for findings and rollout evidence, and [TEST_PORTAL_SETUP.md](./TEST_PORTAL_SETUP.md) for configuration and the production acceptance checklist. A feature's implementation should not be confused with a completed live acceptance check.

## Disqualifications

On the administrator attempt-review page, enter a reason and choose **Disqualify this attempt**. Only that attempt is affected. An active attempt is finalized; saved responses and grades are preserved. The participant sees a DQ status instead of a released score, and the combined Round 1 percentage is withheld. Administrator submission lists and CSV exports mark DQ. **Reinstate this attempt** requires a reason and restores eligibility without reopening solving. Both decisions are recorded in the administrator audit trail. Fullscreen warnings trigger a review lock, never an automatic disqualification.
