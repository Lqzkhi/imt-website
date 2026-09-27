import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('fullscreen exits lock on six, retries are idempotent, upload exits are ignored, and DQ is reversible and audited', async () => {
 const db = new PGlite();
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
   CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);
   CREATE SCHEMA storage; CREATE TABLE storage.buckets(id TEXT PRIMARY KEY,name TEXT,public BOOLEAN,file_size_limit BIGINT,allowed_mime_types TEXT[]);`);
  for (const name of ['20260731_test_portal.sql','20260731_test_portal_hardening.sql','20260926000100_fall_tournament.sql','20260926000300_fall_contest_terms.sql','20260926000400_proof_upload_window.sql','20260926000500_audit_deadline_safety.sql','20260926000600_contest_start_lock.sql','20260926000700_post_test_scratch_window.sql','20260926000800_multiple_proof_files.sql','20260926000900_fullscreen_warnings.sql','20260926001000_attempt_disqualification.sql']) {
   await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
  }
  await db.exec(`UPDATE tests SET opens_at=NOW()-INTERVAL '1 day',closes_at=NOW()+INTERVAL '1 day',require_fullscreen=TRUE;
   UPDATE test_questions SET is_placeholder=FALSE;
   INSERT INTO test_question_keys(question_id,numerical_answer) SELECT id,42 FROM test_questions WHERE answer_type='numerical';
   UPDATE tests SET status='published';`);
  const rows = async (sql,args=[]) => (await db.query(sql,args)).rows;
  const make = async section => {
   const [u] = await rows('INSERT INTO auth.users(id) VALUES(gen_random_uuid()) RETURNING id');
   return (await rows(`INSERT INTO test_attempts(test_id,user_id,started_at,expires_at,terms_accepted_at,terms_snapshot)
    SELECT id,$1,NOW(),NOW()+INTERVAL '2 minutes',NOW(),instructions_latex FROM tests WHERE contest_section=$2 RETURNING *`,[u.id,section]))[0];
  };
  const legacy = await make('computational');
  for(let i=0;i<3;i++) await rows('SELECT * FROM record_fullscreen_exit($1,$2)',[legacy.id,crypto.randomUUID()]);
  assert.ok((await rows('SELECT security_locked_at FROM test_attempts WHERE id=$1',[legacy.id]))[0].security_locked_at);
  await db.exec(await readFile(new URL('../supabase/migrations/20260927001100_six_fullscreen_warnings.sql',import.meta.url),'utf8'));
  const upgraded = (await rows('SELECT * FROM test_attempts WHERE id=$1',[legacy.id]))[0];
  assert.equal(upgraded.security_locked_at,null); assert.equal(upgraded.fullscreen_warnings,3);
  const a = await make('computational');
  const eventId=crypto.randomUUID();
  const exit = async (attempt,id=crypto.randomUUID()) => (await rows('SELECT * FROM record_fullscreen_exit($1,$2)',[attempt.id,id]))[0];
  assert.equal((await exit(a,eventId)).fullscreen_warnings,1);
  assert.equal((await exit(a,eventId)).fullscreen_warnings,1);
  assert.equal((await exit(a)).security_locked_at,null);
  for(let expected=3;expected<=5;expected++) {
   const warning=await exit(a); assert.equal(warning.fullscreen_warnings,expected); assert.equal(warning.security_locked_at,null);
  }
  const locked = await exit(a);
  assert.equal(locked.fullscreen_warnings,6); assert.ok(locked.security_locked_at);
  assert.equal((await exit(a)).fullscreen_warnings,6);
  await assert.rejects(rows(`INSERT INTO test_responses(attempt_id,question_id,response_text)
   SELECT $1,id,'42' FROM test_questions WHERE test_id=$2 ORDER BY position LIMIT 1`,[a.id,a.test_id]),/locked after 6 fullscreen warnings/);
  await rows('UPDATE test_attempts SET fullscreen_warnings=0,security_locked_at=NULL WHERE id=$1',[a.id]);
  await rows(`INSERT INTO test_responses(attempt_id,question_id,response_text)
   SELECT $1,id,'42' FROM test_questions WHERE test_id=$2 ORDER BY position LIMIT 1`,[a.id,a.test_id]);
  const proof=await make('proof'); await rows('SELECT finish_test_work($1)',[proof.id]);
  assert.equal((await exit(proof)).fullscreen_warnings,0);
  const noFullscreen=await make('computational');
  await rows('UPDATE tests SET require_fullscreen=FALSE WHERE id=$1',[noFullscreen.test_id]);
  assert.equal((await exit(noFullscreen)).fullscreen_warnings,0);
  await rows('INSERT INTO test_admins(user_id) VALUES($1)',[proof.user_id]);
  await assert.rejects(rows('SELECT * FROM set_attempt_disqualification($1,$2,TRUE,$3)',[a.id,a.user_id,'Confirmed external assistance']),/Administrator required/);
  await assert.rejects(rows('SELECT * FROM set_attempt_disqualification($1,$2,TRUE,$3)',[a.id,proof.user_id,'']),/reason/);
  const [dq] = await rows('SELECT * FROM set_attempt_disqualification($1,$2,TRUE,$3)',[a.id,proof.user_id,'Confirmed external assistance']);
  assert.ok(dq.disqualified_at); assert.equal(dq.status,'submitted'); assert.equal(Number(dq.score),1);
  assert.equal((await rows('SELECT disqualified_at FROM test_attempts WHERE id=$1',[proof.id]))[0].disqualified_at,null);
  const [restored] = await rows('SELECT * FROM set_attempt_disqualification($1,$2,FALSE,$3)',[a.id,proof.user_id,'Appeal accepted after review']);
  assert.equal(restored.disqualified_at,null); assert.equal(restored.status,'submitted'); assert.equal(Number(restored.score),1);
  assert.equal((await rows(`SELECT count(*)::INTEGER AS total FROM test_admin_audit_log WHERE attempt_id=$1 AND action IN ('attempt_disqualified','attempt_reinstated')`,[a.id]))[0].total,2);
  await db.exec('SET ROLE authenticated');
  await assert.rejects(exit(a),/permission denied/);
  await assert.rejects(rows('SELECT * FROM set_attempt_disqualification($1,$2,TRUE,$3)',[a.id,proof.user_id,'Not authorized']),/permission denied/);
 } finally { await db.close(); }
});

// PostgREST may return a composite RPC as a row array; the client needs the same lock state in either shape.
test('fullscreen event endpoint returns the authoritative lock state for both RPC response shapes', async () => {
 const ts = await import('typescript');
 const source = (await readFile(new URL('../src/pages/api/test-portal/attempts/[attemptId]/events.ts',import.meta.url),'utf8')).replace(/^import .*;\r?$/gm,'').replace('export const POST','const POST');
 const compiled = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 for (const wrapped of [false,true]) {
  const row={id:'attempt',fullscreen_warnings:6,security_locked_at:new Date().toISOString()};
  const ctx={requireSameOrigin:()=>null,authenticatePortalRequest:async()=>({supabase:{rpc:async()=>({data:wrapped?[row]:row,error:null})},user:{id:'owner'}}),getOwnedAttempt:async()=>({attempt:{id:'attempt',status:'in_progress'},test:{}}),finalizeIfExpired:async(_,a)=>a,requireAttemptSession:()=>{},readPortalJson:async()=>({event_type:'fullscreen_exited',metadata:{event_id:crypto.randomUUID()}}),stringField:v=>v,uuidField:v=>v,PORTAL_EVENT_TYPES:new Set(['fullscreen_exited']),portalJson:v=>v,portalErrorResponse:e=>{throw e;},logSecurityEvent:()=>{}};
  const post = new Function(...Object.keys(ctx),compiled+';return POST;')(...Object.values(ctx));
  assert.deepEqual(await post({request:new Request('https://example.test'),params:{attemptId:'attempt'}}),{recorded:true,fullscreen_warnings:6,locked:true});
 }
});
