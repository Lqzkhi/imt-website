import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
// Input and generated SQL contain unreleased material. Keep both outside Git.
const [manifestPath = '.portal-private/fall-2026.json', rulesPath = '.portal-private/contest-instructions.json', outputPath = '.portal-private/import-fall-2026.sql'] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const rules = JSON.parse(await readFile(rulesPath, 'utf8'));
const bundle = {};
for (const section of ['computational', 'proof']) {
  const problems = manifest[section];
  const count = section === 'computational' ? 20 : 5;
  if (!Array.isArray(problems) || problems.length !== count || typeof rules[section] !== 'string' || !rules[section].trim()) throw new Error('Incomplete section: ' + section);
  problems.forEach((p, i) => {
    if (p.position !== i + 1 || typeof p.prompt_latex !== 'string' || !p.prompt_latex.trim() || !p.grading_notes?.trim()) throw new Error('Invalid problem ' + section + ' ' + (i + 1));
    if (section === 'computational' && !/^[+-]?[0-9]{1,100}$/.test(String(p.answer))) throw new Error('Noninteger key at position ' + (i + 1));
    if (p.prompt_latex.includes('**Answer:**') || p.prompt_latex.includes('**Solution.')) throw new Error('Answer material in contestant prompt');
  });
  bundle[section] = { instructions: rules[section], problems };
}
const content = JSON.stringify(bundle);
if (content.includes('$imt_content$')) throw new Error('SQL delimiter collision');
const sql = [
'-- PRIVATE: unreleased statements and answer keys. Do not commit or publish.',
'BEGIN;',
'DO $import$',
'DECLARE',
' content JSONB := $imt_content$' + content + '$imt_content$::JSONB;',
' section TEXT; p JSONB; t public.tests; q UUID; count_questions INTEGER;',
'BEGIN',
" FOR section IN SELECT unnest(ARRAY['computational','proof']) LOOP",
'  SELECT * INTO STRICT t FROM public.tests WHERE contest_section=section FOR UPDATE;',
"  IF t.status<>'draft' OR EXISTS(SELECT 1 FROM public.test_attempts WHERE test_id=t.id) THEN",
"    RAISE EXCEPTION 'Import only untouched Fall drafts: %', section;",
'  END IF;',
'  SELECT count(*) INTO count_questions FROM public.test_questions WHERE test_id=t.id;',
"  IF count_questions<>jsonb_array_length(content->section->'problems') THEN",
"    RAISE EXCEPTION 'Unexpected problem count for %',section;",
'  END IF;',
"  UPDATE public.tests SET instructions_latex=content->section->>'instructions', show_results=FALSE WHERE id=t.id;",
"  FOR p IN SELECT value FROM jsonb_array_elements(content->section->'problems') LOOP",
"   UPDATE public.test_questions SET title=p->>'title', prompt_latex=p->>'prompt_latex',",
"     answer_type=CASE WHEN section='proof' THEN 'file_upload' ELSE 'numerical' END,",
"     points=CASE WHEN section='proof' THEN 7 ELSE 1 END, is_placeholder=FALSE,",
"     file_extensions=ARRAY['pdf','png','jpg','jpeg','webp'], max_file_size_mb=10",
"   WHERE test_id=t.id AND position=(p->>'position')::INTEGER RETURNING id INTO STRICT q;",
'   INSERT INTO public.test_question_keys(question_id,numerical_answer,numerical_tolerance,choice_key,grading_notes)',
"   VALUES(q,CASE WHEN section='computational' THEN (p->>'answer')::NUMERIC ELSE NULL END,0,NULL,p->>'grading_notes')",
'   ON CONFLICT(question_id) DO UPDATE SET numerical_answer=EXCLUDED.numerical_answer,',
'     numerical_tolerance=0,choice_key=NULL,grading_notes=EXCLUDED.grading_notes;',
'  END LOOP;',
' END LOOP;',
'END $import$;',
'COMMIT;',
'-- Contests remain drafts until production acceptance checks have passed.',
].join('\n') + '\n';
await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(outputPath, sql);
console.log('Prepared private import: 20 integer keys and 5 proof rubrics. Contests remain drafts.');
