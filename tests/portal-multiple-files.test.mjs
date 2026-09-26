import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('multiple proof attachments preserve legacy files, serialize edits, and enforce phase, limits, and submission', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);
      CREATE SCHEMA storage; CREATE TABLE storage.buckets(id TEXT PRIMARY KEY,name TEXT,public BOOLEAN,file_size_limit BIGINT,allowed_mime_types TEXT[]);`);
    const migrate = async name => db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
    for (const name of ['20260731_test_portal.sql','20260731_test_portal_hardening.sql','20260926000100_fall_tournament.sql','20260926000300_fall_contest_terms.sql','20260926000400_proof_upload_window.sql','20260926000500_audit_deadline_safety.sql','20260926000600_contest_start_lock.sql','20260926000700_post_test_scratch_window.sql']) await migrate(name);
    const rows = async (sql,args=[]) => (await db.query(sql,args)).rows;
    await db.exec(`UPDATE tests SET opens_at=NOW()-INTERVAL '1 day',closes_at=NOW()+INTERVAL '1 day'; UPDATE tests SET duration_minutes=180 WHERE contest_section='computational';
      UPDATE test_questions SET is_placeholder=FALSE;
      INSERT INTO test_question_keys(question_id,numerical_answer) SELECT id,42 FROM test_questions WHERE answer_type='numerical'; UPDATE tests SET status='published';`);
    const [user] = await rows('INSERT INTO auth.users(id) VALUES(gen_random_uuid()) RETURNING id');
    const [attempt] = await rows(`INSERT INTO test_attempts(test_id,user_id,expires_at,terms_accepted_at,terms_snapshot) SELECT id,$1,NOW()+INTERVAL '2 hours',NOW(),instructions_latex FROM tests WHERE contest_section='proof' RETURNING *`,[user.id]);
    const [q] = await rows('SELECT * FROM test_questions WHERE test_id=$1 ORDER BY position',[attempt.test_id]);
    await rows('SELECT finish_test_work($1)',[attempt.id]);
    const [legacy] = await rows(`INSERT INTO test_responses(attempt_id,question_id,file_path,file_name,file_mime_type) VALUES($1,$2,'legacy.pdf','legacy.pdf','application/pdf') RETURNING *`,[attempt.id,q.id]);
    await migrate('20260926000800_multiple_proof_files.sql');
    assert.equal((await rows('SELECT duration_minutes FROM tests WHERE contest_section=\'computational\''))[0].duration_minutes,180);
    assert.equal((await rows('SELECT files FROM test_responses WHERE id=$1',[legacy.id]))[0].files[0].file_name,'legacy.pdf');
    const file = n => ({file_path:`${n}.pdf`,file_name:`${n}.pdf`,file_mime_type:'application/pdf'});
    const add = n => rows('SELECT * FROM edit_proof_files($1,$2,$3::JSONB)',[attempt.id,q.id,JSON.stringify(file(n))]);
    await Promise.all([add(1),add(2)]);
    assert.equal((await rows('SELECT files FROM test_responses WHERE id=$1',[legacy.id]))[0].files.length,3);
    await add(2); // Retry cannot duplicate a linked file.
    assert.equal((await rows('SELECT files FROM test_responses WHERE id=$1',[legacy.id]))[0].files.length,3);
    await rows('SELECT * FROM edit_proof_files($1,$2,NULL,$3)',[attempt.id,q.id,'1.pdf']);
    assert.deepEqual((await rows('SELECT files FROM test_responses WHERE id=$1',[legacy.id]))[0].files.map(f=>f.file_name),['legacy.pdf','2.pdf']);
    for(let n=3;n<=10;n++) await add(n);
    await assert.rejects(add(11),/At most 10 proof files/);
    await rows("SELECT finalize_test_attempt($1,'submitted')",[attempt.id]);
    await assert.rejects(add(12),/Attempt closed/);
    await assert.rejects(rows("UPDATE test_responses SET files='[]' WHERE id=$1",[legacy.id]),/Attempt closed/);
    await rows("UPDATE test_responses SET feedback='Grading still allowed',points_awarded=3,grading_status='manually_graded' WHERE id=$1",[legacy.id]);
    assert.equal((await rows('SELECT count(*)::INTEGER n FROM test_responses WHERE attempt_id=$1',[attempt.id]))[0].n,1);
    const [other] = await rows('INSERT INTO auth.users(id) VALUES(gen_random_uuid()) RETURNING id');
    const [solving] = await rows(`INSERT INTO test_attempts(test_id,user_id,expires_at,terms_accepted_at,terms_snapshot) SELECT id,$1,NOW()+INTERVAL '1 hour',NOW(),instructions_latex FROM tests WHERE contest_section='proof' RETURNING *`,[other.id]);
    await assert.rejects(rows('SELECT * FROM edit_proof_files($1,$2,$3::JSONB)',[solving.id,q.id,JSON.stringify(file(1))]),/Finish the proof round/);
  } finally { await db.close(); }
});
