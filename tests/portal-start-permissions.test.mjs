import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('service role can start contests without auth.users privileges and cannot overlap sections', async () => {
  const db = new PGlite();
  const migration = async name => db.exec((await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);
      CREATE SCHEMA storage; CREATE TABLE storage.buckets(id TEXT PRIMARY KEY,name TEXT,public BOOLEAN,file_size_limit BIGINT,allowed_mime_types TEXT[]);`);
    for (const name of ['20260731_test_portal.sql', '20260731_test_portal_hardening.sql', '20260926000100_fall_tournament.sql', '20260926000300_fall_contest_terms.sql', '20260926000400_proof_upload_window.sql', '20260926000500_audit_deadline_safety.sql']) await migration(name);
    await db.exec(`UPDATE tests SET opens_at=NOW()-INTERVAL '1 day',closes_at=NOW()+INTERVAL '1 day';
      UPDATE test_questions SET is_placeholder=FALSE;
      INSERT INTO test_question_keys(question_id,numerical_answer) SELECT id,42 FROM test_questions WHERE answer_type='numerical';
      UPDATE tests SET status='published';
      GRANT USAGE ON SCHEMA public,auth TO service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      INSERT INTO auth.users(id) VALUES('11111111-1111-4111-8111-111111111111');`);
    const start = section => db.query(`INSERT INTO test_attempts(test_id,user_id,started_at,expires_at,terms_accepted_at,terms_snapshot)
      SELECT id,'11111111-1111-4111-8111-111111111111',NOW(),NOW()+INTERVAL '2 minutes',NOW(),instructions_latex
      FROM tests WHERE contest_section=$1 RETURNING id`, [section]);
    await db.exec('SET ROLE service_role');
    await assert.rejects(start('proof'), /permission denied for table users/);
    await db.exec('RESET ROLE');
    await migration('20260926000600_contest_start_lock.sql');
    await db.exec('SET ROLE service_role');
    await assert.rejects(db.query('SELECT * FROM auth.users'), /permission denied/);
    const proof = (await start('proof')).rows[0];
    await assert.rejects(start('computational'), /Finish your other contest section/);
    await db.query('SELECT finish_test_work($1)', [proof.id]);
    await assert.rejects(start('computational'), /Finish your other contest section/);
    await db.query("SELECT finalize_test_attempt($1,'submitted')", [proof.id]);
    assert.equal((await start('computational')).rows.length, 1);
    await assert.rejects(db.query('SELECT * FROM auth.users'), /permission denied/);
  } finally { await db.close(); }
});
