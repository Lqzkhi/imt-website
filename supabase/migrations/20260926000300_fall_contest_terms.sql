-- Fall integer extraction rules and auditable before-start acknowledgement.
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE public.test_attempts ADD COLUMN IF NOT EXISTS terms_snapshot TEXT NOT NULL DEFAULT '';
CREATE OR REPLACE FUNCTION public.guard_fall_attempt_terms() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE t public.tests;
BEGIN
 SELECT * INTO t FROM public.tests WHERE id=NEW.test_id FOR SHARE;
 IF t.contest_section IS NOT NULL AND (NEW.terms_accepted_at IS NULL OR NEW.terms_snapshot IS DISTINCT FROM t.instructions_latex OR length(NEW.terms_snapshot)=0) THEN
   RAISE EXCEPTION 'Accept the current contest terms before starting';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_fall_attempt_terms BEFORE INSERT ON public.test_attempts
FOR EACH ROW EXECUTE FUNCTION public.guard_fall_attempt_terms();
CREATE OR REPLACE FUNCTION public.guard_fall_integer_response() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.test_questions q JOIN public.tests t ON t.id=q.test_id
   WHERE q.id=NEW.question_id AND t.contest_section='computational' AND q.answer_type='numerical')
   AND (NEW.response_text IS NULL OR NEW.response_text !~ '^[+-]?[0-9]{1,100}$') THEN
   RAISE EXCEPTION 'Computational answers must be integer extractions';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_fall_integer_response BEFORE INSERT OR UPDATE ON public.test_responses
FOR EACH ROW EXECUTE FUNCTION public.guard_fall_integer_response();
CREATE OR REPLACE FUNCTION public.guard_fall_integer_key() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.test_questions q JOIN public.tests t ON t.id=q.test_id
   WHERE q.id=NEW.question_id AND t.contest_section='computational')
   AND NEW.numerical_answer IS NOT NULL
   AND (NEW.numerical_answer<>trunc(NEW.numerical_answer) OR NEW.numerical_tolerance<>0) THEN
   RAISE EXCEPTION 'Computational keys require an integer and zero tolerance';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_fall_integer_key BEFORE INSERT OR UPDATE ON public.test_question_keys
FOR EACH ROW EXECUTE FUNCTION public.guard_fall_integer_key();

UPDATE public.tests t SET instructions_latex=$rules$Computational round — before you begin
There are 20 problems and you have 120 minutes. Every requested answer is an integer. Some statements ask you to extract an integer from a noninteger quantity; follow the instruction in that statement. The notation \(\lfloor x\rfloor\) means the greatest integer not exceeding \(x\). When a statement writes a rational number as \(p/q\) in lowest terms and asks for \(p+q\), enter that sum.

Enter only the integer: no commas, units, decimals, fractions, expressions, or scientific notation. Negative integers and zero are allowed when appropriate. There is no three-digit answer limit and no reduction modulo 1000. Do not round unless the statement explicitly instructs you to. Each correct answer earns 1 point; an incorrect or blank answer earns 0, with no penalty for guessing. Save one answer per problem. Scratch uploads are optional and are not scored.

Contest terms
Work independently and submit only your own work. You may use blank scratch paper, pens or pencils, a ruler, and a compass. Do not use calculators, computer algebra, AI tools, reference materials, internet searches, or help from another person. Use your device only for the portal and for scanning or photographing and uploading your own work. Do not share or discuss the problems before the tournament closes.

Each section has one attempt and a continuous server timer. Refreshing the same tab is safe; changing tabs or devices may require an administrator unlock. The timer does not pause during disconnections. Your deadline is the earlier of your personal time limit and the current tournament cutoff displayed above. Only answers and uploads saved to the server before that deadline count. Confirm the saved status of your work. Submission is final; at the deadline the server automatically submits saved work.

Focus and visibility changes, submission activity, and administrator actions are recorded for integrity review. These signals do not by themselves establish misconduct. Proof and scratch files are private and accessible to you and authorized tournament staff through expiring links. Contact portal support promptly about technical or accessibility issues.

Scores and feedback are withheld until the organizers release results after the contest and grading are complete. Each section contributes 50% of the combined Round 1 percentage. Organizers review integrity concerns and grading disputes before making decisions. Starting this section acknowledges these rules.$rules$, description='20 integer-answer problems · 2 hours · 50% of your Round 1 score.' WHERE contest_section='computational' AND status='draft' AND NOT EXISTS(SELECT 1 FROM public.test_attempts a WHERE a.test_id=t.id);

UPDATE public.tests t SET instructions_latex=$rules$Proof round — before you begin
There are 5 problems and you have 270 minutes. Each is worth 7 points and partial credit is available. Provide complete, legible arguments, including necessity and sufficiency when appropriate. Upload one PDF or image per problem; combine multiple pages into a single PDF. Check that the uploaded file opens and that all pages are present. Scratch uploads are optional supplements and do not replace proof submissions.

Contest terms
Work independently and submit only your own work. You may use blank scratch paper, pens or pencils, a ruler, and a compass. Do not use calculators, computer algebra, AI tools, reference materials, internet searches, or help from another person. Use your device only for the portal and for scanning or photographing and uploading your own work. Do not share or discuss the problems before the tournament closes.

Each section has one attempt and a continuous server timer. Refreshing the same tab is safe; changing tabs or devices may require an administrator unlock. The timer does not pause during disconnections. Your deadline is the earlier of your personal time limit and the current tournament cutoff displayed above. Only answers and uploads saved to the server before that deadline count. Confirm the saved status of your work. Submission is final; at the deadline the server automatically submits saved work.

Focus and visibility changes, submission activity, and administrator actions are recorded for integrity review. These signals do not by themselves establish misconduct. Proof and scratch files are private and accessible to you and authorized tournament staff through expiring links. Contact portal support promptly about technical or accessibility issues.

Scores and feedback are withheld until the organizers release results after the contest and grading are complete. Each section contributes 50% of the combined Round 1 percentage. Organizers review integrity concerns and grading disputes before making decisions. Starting this section acknowledges these rules.$rules$ WHERE contest_section='proof' AND status='draft' AND NOT EXISTS(SELECT 1 FROM public.test_attempts a WHERE a.test_id=t.id);
