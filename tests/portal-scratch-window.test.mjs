import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('scratch uploads only follow solving, remain independent of proof submission, and expire after 30 minutes', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);
      CREATE SCHEMA storage; CREATE TABLE storage.buckets(id TEXT PRIMARY KEY,name TEXT,public BOOLEAN,file_size_limit BIGINT,allowed_mime_types TEXT[]);`);
    for (const name of ['20260731_test_portal.sql','20260731_test_portal_hardening.sql','20260926000100_fall_tournament.sql','20260926000300_fall_contest_terms.sql','20260926000400_proof_upload_window.sql','20260926000500_audit_deadline_safety.sql','20260926000600_contest_start_lock.sql','20260926000700_post_test_scratch_window.sql']) {
      await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
    }
    await db.exec(`UPDATE tests SET opens_at=NOW()-INTERVAL '2 days',closes_at=NOW()+INTERVAL '2 days';
      UPDATE test_questions SET is_placeholder=FALSE;
      INSERT INTO test_question_keys(question_id,numerical_answer) SELECT id,42 FROM test_questions WHERE answer_type='numerical';
      UPDATE tests SET status='published';`);
    const rows = async (sql,args=[]) => (await db.query(sql,args)).rows;
    const make = async (section, minutes = 2) => {
      const [user] = await rows('INSERT INTO auth.users(id) VALUES(gen_random_uuid()) RETURNING id');
      return (await rows(`INSERT INTO test_attempts(test_id,user_id,started_at,expires_at,terms_accepted_at,terms_snapshot)
        SELECT id,$1,NOW()-make_interval(mins=>duration_minutes)+make_interval(mins=>$2),NOW()+make_interval(mins=>$2),NOW(),instructions_latex
        FROM tests WHERE contest_section=$3 RETURNING *`, [user.id,minutes,section]))[0];
    };
    const scratch = async a => (await rows(`INSERT INTO test_scratch_files(attempt_id,file_path,file_name,mime_type,size_bytes)
      VALUES($1,$2,'scratch.pdf','application/pdf',100) RETURNING id`, [a.id,`${a.user_id}/${a.id}/scratch/${crypto.randomUUID()}.pdf`]))[0];
    const deadline = async a => (await rows('SELECT scratch_upload_deadline(a) AS deadline FROM test_attempts a WHERE id=$1',[a.id]))[0].deadline;
    const comp = await make('computational');
    await assert.rejects(scratch(comp),/Scratch uploads open after solving ends/);
    await rows("SELECT finalize_test_attempt($1,'submitted')",[comp.id]);
    const end = (await rows('SELECT submitted_at FROM test_attempts WHERE id=$1',[comp.id]))[0].submitted_at;
    assert.equal((await deadline(comp))-end,1800000);
    const saved = await scratch(comp);
    await assert.rejects(rows(`INSERT INTO test_responses(attempt_id,question_id,response_text)
      SELECT $1,id,'42' FROM test_questions WHERE test_id=$2 ORDER BY position LIMIT 1`,[comp.id,comp.test_id]),/Attempt closed/);
    await rows('DELETE FROM test_scratch_files WHERE id=$1',[saved.id]);
    for (let i=0;i<10;i++) await scratch(comp);
    await assert.rejects(scratch(comp),/At most 10 scratch files/);
    const proof = await make('proof');
    await assert.rejects(scratch(proof),/Scratch uploads open after solving ends/);
    const [phase] = await rows('SELECT * FROM finish_test_work($1)',[proof.id]);
    assert.equal(phase.expires_at-phase.working_ended_at,900000);
    assert.equal((await deadline(proof))-phase.working_ended_at,1800000);
    const before = await deadline(proof);
    await scratch(proof);
    await rows("SELECT finalize_test_attempt($1,'submitted')",[proof.id]);
    assert.equal((await deadline(proof)).getTime(),before.getTime());
    await scratch(proof);
    for (const section of ['proof','computational']) {
      const offline = await make(section,-20);
      await rows("SELECT finalize_test_attempt($1,'timed_out')",[offline.id]);
      assert.equal((await rows('SELECT status FROM test_attempts WHERE id=$1',[offline.id]))[0].status,'timed_out');
      await scratch(offline);
      const late = await make(section,-31);
      await rows("SELECT finalize_test_attempt($1,'timed_out')",[late.id]);
      await assert.rejects(scratch(late),/Scratch upload window closed/);
    }
    await db.exec('SET ROLE authenticated');
    await assert.rejects(rows('SELECT * FROM test_scratch_files'),/permission denied/);
  } finally { await db.close(); }
});
