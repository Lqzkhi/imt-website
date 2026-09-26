import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('Fall portal database: deadlines, grading, scratch limits, access, and atomic submission', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);
      CREATE SCHEMA storage; CREATE TABLE storage.buckets(id TEXT PRIMARY KEY,name TEXT,public BOOLEAN,file_size_limit BIGINT,allowed_mime_types TEXT[]);`);
    for (const name of ['20260731_test_portal.sql','20260731_test_portal_hardening.sql','20260926000100_fall_tournament.sql','20260926000300_fall_contest_terms.sql']) {
      const sql = (await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
      await db.exec(sql);
    }
    const rows = async (sql,args=[]) => (await db.query(sql,args)).rows;
    const [proof] = await rows("SELECT * FROM tests WHERE contest_section='proof'");
    const [computational] = await rows("SELECT * FROM tests WHERE contest_section='computational'");
    assert.equal(proof.duration_minutes,270); assert.equal(computational.duration_minutes,120);
    assert.equal(proof.status,'draft'); assert.equal(proof.closes_at.toISOString(),'2026-10-11T04:00:00.000Z');
    assert.deepEqual((await rows('SELECT test_id,count(*)::INTEGER AS n FROM test_questions GROUP BY test_id')).map(r=>r.n).sort((a,b)=>a-b),[5,20]);
    assert.equal((await rows('SELECT count(*)::INTEGER n FROM test_questions WHERE is_placeholder'))[0].n,25);
    const user='11111111-1111-4111-8111-111111111111'; const admin='22222222-2222-4222-8222-222222222222';
    await db.query('INSERT INTO auth.users(id) VALUES($1),($2)',[user,admin]);
    await db.query('INSERT INTO test_admins(user_id) VALUES($1)',[admin]);
    await db.exec("UPDATE tests SET opens_at=NOW()-INTERVAL '1 day',closes_at=NOW()+INTERVAL '1 day';");
    await db.exec("UPDATE test_questions SET is_placeholder=FALSE; INSERT INTO test_question_keys(question_id,numerical_answer) SELECT id,42 FROM test_questions WHERE answer_type='numerical'; UPDATE tests SET status='published';");
    const createAttempt = async (testId) => (await rows("INSERT INTO test_attempts(test_id,user_id,expires_at,terms_accepted_at,terms_snapshot) SELECT $1,$2,NOW()+INTERVAL '1 hour',NOW(),instructions_latex FROM tests WHERE id=$1 RETURNING *",[testId,user]))[0];
    await assert.rejects(db.query('UPDATE tests SET show_results=TRUE WHERE id=$1',[proof.id]),/Wait until/);
    await assert.rejects(db.query("INSERT INTO test_attempts(test_id,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour')",[proof.id,user]),/Accept the current contest terms/);
    const attempt=await createAttempt(proof.id);
    assert.equal(attempt.terms_snapshot, (await rows('SELECT instructions_latex FROM tests WHERE id=$1',[proof.id]))[0].instructions_latex);
    assert.ok(attempt.terms_accepted_at);
    await assert.rejects(db.query('UPDATE test_questions SET points=6 WHERE test_id=$1',[proof.id]),/structure locked/);
    const qs=await rows('SELECT * FROM test_questions WHERE test_id=$1 ORDER BY position',[proof.id]);
    const [response]=await rows("INSERT INTO test_responses(attempt_id,question_id,file_path,file_name,file_mime_type) VALUES($1,$2,'proof.pdf','proof.pdf','application/pdf') RETURNING *",[attempt.id,qs[0].id]);
    for(let n=0;n<10;n++) await db.query('INSERT INTO test_scratch_files(attempt_id,file_path,file_name,mime_type,size_bytes) VALUES($1,$2,$3,$4,100)',[attempt.id,`${user}/${attempt.id}/scratch/${n}.pdf`,`${n}.pdf`,'application/pdf']);
    await assert.rejects(db.query("INSERT INTO test_scratch_files(attempt_id,file_path,file_name,mime_type,size_bytes) VALUES($1,$2,'extra.pdf','application/pdf',100)",[attempt.id,`${user}/${attempt.id}/scratch/extra.pdf`]),/At most 10/);
    await assert.rejects(db.query("SELECT * FROM finalize_test_attempt($1,'wrong')",[attempt.id]),/Invalid submission/);
    const [submitted]=await rows("SELECT * FROM finalize_test_attempt($1,'submitted')",[attempt.id]);
    assert.equal(submitted.status,'submitted'); assert.equal(submitted.grading_status,'pending_manual'); assert.equal(Number(submitted.max_score),35);
    await assert.rejects(db.query("UPDATE test_responses SET file_name='changed.pdf' WHERE id=$1",[response.id]),/Attempt closed/);
    await assert.rejects(db.query("UPDATE test_responses SET answered_at=clock_timestamp(),grading_status='ungraded' WHERE id=$1",[response.id]),/Attempt closed/);
    await assert.rejects(db.query('DELETE FROM test_scratch_files WHERE attempt_id=$1',[attempt.id]),/Attempt closed/);
    const [graded]=await rows('SELECT * FROM grade_test_response($1,$2,4,$3,NULL)',[response.id,admin,'Useful idea; proof has a gap.']);
    assert.equal(Number(graded.score),4); assert.equal(graded.grading_status,'complete');
    await assert.rejects(db.query('SELECT * FROM grade_test_response($1,$2,5,$3,NULL)',[response.id,admin,'stale']),/Grade changed/);
    await assert.rejects(db.query('SELECT * FROM grade_test_response($1,$2,8,$3,NULL)',[response.id,user,'unauthorized']),/Administrator required/);
    assert.equal((await rows('SELECT count(*)::INTEGER n FROM test_admin_audit_log'))[0].n,1);
    const numerical=await createAttempt(computational.id);
    const [nq]=await rows('SELECT * FROM test_questions WHERE test_id=$1 ORDER BY position LIMIT 1',[computational.id]);
    for (const invalid of ['42.0','42/1','4.2e1','0x2a','42,000']) await assert.rejects(db.query('INSERT INTO test_responses(attempt_id,question_id,response_text) VALUES($1,$2,$3)',[numerical.id,nq.id,invalid]),/integer extractions/);
    await db.query("INSERT INTO test_responses(attempt_id,question_id,response_text) VALUES($1,$2,'42')",[numerical.id,nq.id]);
    await db.query("UPDATE test_attempts SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[numerical.id]);
    assert.equal((await rows('SELECT submit_expired_test_attempts() n'))[0].n,1);
    const [timed]=await rows('SELECT * FROM test_attempts WHERE id=$1',[numerical.id]);
    assert.equal(timed.status,'timed_out'); assert.equal(timed.auto_submitted,true); assert.equal(Number(timed.score),1);
    assert.equal(timed.submitted_at.toISOString(),timed.expires_at.toISOString());
    await rows("SELECT * FROM finalize_test_attempt($1,'submitted')",[numerical.id]);
    assert.equal((await rows("SELECT count(*)::INTEGER n FROM test_security_events WHERE attempt_id=$1 AND event_type='timed_out'",[numerical.id]))[0].n,1);
    assert.equal((await rows('SELECT submit_expired_test_attempts() n'))[0].n,0);
    assert.ok((await rows('SELECT last_run_at FROM test_portal_job_health'))[0].last_run_at);
    await db.exec('SET ROLE authenticated;');
    await assert.rejects(db.query('SELECT * FROM test_question_keys'),/permission denied/);
    await assert.rejects(db.query('SELECT * FROM test_scratch_files'),/permission denied/);
    await assert.rejects(db.query('SELECT submit_expired_test_attempts()'),/permission denied/);
    await db.exec('RESET ROLE;');
    // A new participant is used to verify closing-time edits and extension caps.
    const other='33333333-3333-4333-8333-333333333333'; await db.query('INSERT INTO auth.users(id) VALUES($1)',[other]);
    const [active]=await rows("INSERT INTO test_attempts(test_id,user_id,expires_at,extension_minutes,terms_accepted_at,terms_snapshot) SELECT $1,$2,NOW()+INTERVAL '1 hour',30,NOW(),instructions_latex FROM tests WHERE id=$1 RETURNING *",[proof.id,other]);
    await db.query("UPDATE tests SET closes_at=NOW()+INTERVAL '10 minutes' WHERE id=$1",[proof.id]);
    const [capped]=await rows('SELECT a.expires_at=t.closes_at capped FROM test_attempts a JOIN tests t ON t.id=a.test_id WHERE a.id=$1',[active.id]);
    assert.equal(capped.capped,true);
    await db.query("UPDATE tests SET closes_at=NOW()+INTERVAL '2 days' WHERE id=$1",[proof.id]);
    assert.equal((await rows("SELECT expires_at=started_at+INTERVAL '300 minutes' extended FROM test_attempts WHERE id=$1",[active.id]))[0].extended,true);
    await db.query("UPDATE tests SET closes_at=NOW()-INTERVAL '1 second' WHERE id=$1",[proof.id]);
    await assert.rejects(db.query('UPDATE tests SET show_results=TRUE WHERE id=$1',[proof.id]),/Finish submission/);
    await rows('SELECT submit_expired_test_attempts()');
    await db.query('UPDATE tests SET show_results=TRUE WHERE id=$1',[proof.id]);
    assert.equal((await rows('SELECT show_results FROM tests WHERE id=$1',[proof.id]))[0].show_results,true);
    await db.query("UPDATE tests SET closes_at=NOW()+INTERVAL '2 days' WHERE id=$1",[proof.id]);
    assert.equal((await rows('SELECT status FROM test_attempts WHERE id=$1',[active.id]))[0].status,'timed_out');
  } finally { await db.close(); }
});

test('live-schema compatibility: reuse existing Fall drafts and replace a composite RPC', async () => {
 const db=new PGlite();
 try{
  await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);CREATE SCHEMA storage;CREATE TABLE storage.buckets(id TEXT PRIMARY KEY,name TEXT,public BOOLEAN,file_size_limit BIGINT,allowed_mime_types TEXT[]);");
  for(const name of ['20260731_test_portal.sql','20260731_test_portal_hardening.sql']) await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
  await db.exec("ALTER TABLE tests ADD COLUMN competition_slug TEXT;ALTER TABLE test_attempts ADD COLUMN submission_source TEXT NOT NULL DEFAULT 'participant';CREATE FUNCTION public.finalize_test_attempt(p_attempt_id UUID,p_reason TEXT DEFAULT 'timed_out') RETURNS public.test_attempts LANGUAGE plpgsql AS $$DECLARE a public.test_attempts;BEGIN SELECT * INTO a FROM public.test_attempts WHERE id=p_attempt_id;RETURN a;END$$;");
  const old=(await db.query("INSERT INTO tests(title,duration_minutes,competition_slug) VALUES('Fall 2026 Round 1 — Computational Section',120,'fall-2026'),('Fall 2026 Round 1 — Proof Section',270,'fall-2026') RETURNING id,title")).rows;
  for(const name of ['20260926000100_fall_tournament.sql','20260926000300_fall_contest_terms.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  const current=(await db.query('SELECT * FROM tests')).rows;
  assert.equal(current.length,2);
  assert.deepEqual(current.map(r=>r.id).sort(),old.map(r=>r.id).sort());
  assert.ok(current.every(r=>r.contest_section&&r.closes_at.toISOString()==='2026-10-11T04:00:00.000Z'));
  assert.equal((await db.query("SELECT proretset FROM pg_proc WHERE oid='public.finalize_test_attempt(uuid,text)'::regprocedure")).rows[0].proretset,false);
 }finally{await db.close();}
});


test('proof round has a locked 15-minute upload phase and closes without browser activity', async () => {
 const db=new PGlite();
 try {
  await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);CREATE SCHEMA storage;CREATE TABLE storage.buckets(id TEXT PRIMARY KEY,name TEXT,public BOOLEAN,file_size_limit BIGINT,allowed_mime_types TEXT[]);');
  for(const name of ['20260731_test_portal.sql','20260731_test_portal_hardening.sql','20260926000100_fall_tournament.sql','20260926000300_fall_contest_terms.sql','20260926000400_proof_upload_window.sql'])
   await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
  const rows=async(sql,args=[]) => (await db.query(sql,args)).rows;
  const [proof]=await rows("SELECT * FROM tests WHERE contest_section='proof'");
  const [comp]=await rows("SELECT * FROM tests WHERE contest_section='computational'");
  assert.ok(proof.require_fullscreen && proof.block_clipboard && comp.require_fullscreen && comp.block_clipboard);
  await db.exec("UPDATE tests SET opens_at=NOW()-INTERVAL '2 days',closes_at=NOW()+INTERVAL '2 days';UPDATE test_questions SET is_placeholder=FALSE;INSERT INTO test_question_keys(question_id,numerical_answer) SELECT id,42 FROM test_questions WHERE answer_type='numerical';UPDATE tests SET status='published';");
  const make=async(id=proof.id) => {
   const [u]=await rows('INSERT INTO auth.users(id) VALUES(gen_random_uuid()) RETURNING id');
   return (await rows("INSERT INTO test_attempts(test_id,user_id,started_at,expires_at,terms_accepted_at,terms_snapshot) SELECT $1,$2,NOW()-INTERVAL '1 day',NOW()+INTERVAL '1 hour',NOW(),instructions_latex FROM tests WHERE id=$1 RETURNING *",[id,u.id]))[0];
  };
  const [q]=await rows('SELECT * FROM test_questions WHERE test_id=$1 ORDER BY position LIMIT 1',[proof.id]);
  const upload=async(a) => (await rows("INSERT INTO test_responses(attempt_id,question_id,file_path,file_name,file_mime_type) VALUES($1,$2,'proof.pdf','proof.pdf','application/pdf') RETURNING *",[a.id,q.id]))[0];
  // Set a future solving deadline for the early-finish case.
  const early=await make();await db.query("UPDATE test_attempts SET expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",[early.id]);
  await assert.rejects(upload(early),/Finish the proof round/);
  await assert.rejects(db.query("INSERT INTO test_scratch_files(attempt_id,file_path,file_name,mime_type,size_bytes) VALUES($1,$2,'scratch.pdf','application/pdf',10)",[early.id,early.user_id+'/'+early.id+'/scratch/a.pdf']),/Finish the proof round/);
  const [window]=await rows("SELECT * FROM finalize_test_attempt($1,'submitted')",[early.id]);
  assert.equal(window.status,'in_progress');assert.equal(window.working_end_reason,'submitted');assert.equal(window.submitted_at,null);
  assert.equal(window.expires_at-window.working_ended_at,15*60*1000);
  await assert.rejects(db.query("INSERT INTO test_attempts(test_id,user_id,expires_at,terms_accepted_at,terms_snapshot) SELECT $1,$2,NOW()+INTERVAL '1 hour',NOW(),instructions_latex FROM tests WHERE id=$1",[comp.id,window.user_id]),/Finish your other contest section/);
  const response=await upload(window);
  await assert.rejects(db.query("UPDATE test_attempts SET expires_at=expires_at+INTERVAL '1 minute' WHERE id=$1",[window.id]),/deadline is locked/);
  await db.query("UPDATE tests SET closes_at=NOW()+INTERVAL '3 days' WHERE id=$1",[proof.id]);
  assert.equal((await rows('SELECT expires_at FROM test_attempts WHERE id=$1',[window.id]))[0].expires_at.toISOString(),window.expires_at.toISOString());
  const [submitted]=await rows("SELECT * FROM finalize_test_attempt($1,'submitted')",[window.id]);
  assert.equal(submitted.status,'submitted');assert.equal(submitted.grading_status,'pending_manual');
  await db.query('INSERT INTO test_admins(user_id) VALUES($1)',[early.user_id]);
  const [graded]=await rows('SELECT * FROM grade_test_response($1,$2,4,$3,NULL)',[response.id,early.user_id,'Verified partial credit after upload closure']);
  assert.equal(Number(graded.score),4);assert.equal(graded.grading_status,'complete');
  await assert.rejects(db.query("UPDATE test_responses SET file_name='changed.pdf' WHERE id=$1",[response.id]),/Attempt closed/);
  // An absent contestant gets the window anchored to the original solving cutoff.
  const late=await make();await db.query("UPDATE test_attempts SET expires_at=NOW()-INTERVAL '5 minutes' WHERE id=$1",[late.id]);
  const [lateWindow]=await rows("SELECT * FROM finalize_test_attempt($1,'timed_out')",[late.id]);
  assert.equal(lateWindow.status,'in_progress');assert.equal(lateWindow.working_end_reason,'timed_out');
  assert.equal((await rows("SELECT abs(extract(epoch FROM (expires_at-(NOW()+INTERVAL '10 minutes'))))<2 ok FROM test_attempts WHERE id=$1",[late.id]))[0].ok,true);
  const [retry]=await rows("SELECT * FROM finalize_test_attempt($1,'timed_out')",[late.id]);
  assert.equal(retry.expires_at.toISOString(),lateWindow.expires_at.toISOString());assert.equal(retry.status,'in_progress');
  // The scheduler closes a missed upload window in the same call, even after a long outage.
  const absent=await make();await db.query("UPDATE test_attempts SET expires_at=NOW()-INTERVAL '16 minutes' WHERE id=$1",[absent.id]);
  await rows('SELECT submit_expired_test_attempts()');
  const [closed]=await rows('SELECT * FROM test_attempts WHERE id=$1',[absent.id]);
  assert.equal(closed.status,'timed_out');assert.equal(closed.auto_submitted,true);
  assert.equal(closed.submitted_at.toISOString(),closed.expires_at.toISOString());
  assert.equal(closed.expires_at-closed.working_ended_at,15*60*1000);
  await assert.rejects(upload(closed),/Attempt closed/);
  const computational=await make(comp.id);const [finished]=await rows("SELECT * FROM finalize_test_attempt($1,'timed_out')",[computational.id]);
  assert.equal(finished.status,'timed_out');assert.equal(finished.working_ended_at,null);
  await db.exec('SET ROLE authenticated');
  await assert.rejects(db.query("SELECT finalize_test_attempt_closed($1,'submitted')",[window.id]),/permission denied/);
  await assert.rejects(db.query("SELECT finalize_test_attempt($1,'submitted')",[window.id]),/permission denied/);
 } finally { await db.close(); }
});
