import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchEligibility } from '../src/lib/portalEligibility.ts';

test('both sections require scratch uploads; eligibility remains pending until each upload window ends', () => {
 const now=Date.parse('2026-09-27T12:00:00Z');
 const section = (minutesAgo,count=0) => ({status:'submitted',expires_at:new Date(now).toISOString(),submitted_at:new Date(now-minutesAgo*60000).toISOString(),scratch_file_count:count});
 assert.equal(scratchEligibility({},now).status,'pending');
 assert.equal(scratchEligibility({computational:{status:'in_progress',expires_at:new Date(now-31*60000).toISOString()}},now).status,'ineligible');
 assert.equal(scratchEligibility({computational:section(20),proof:section(10)},now).status,'pending');
 const missing=scratchEligibility({computational:section(31),proof:section(10,1)},now);
 assert.equal(missing.status,'ineligible');assert.match(missing.label,/computational/);
 assert.equal(scratchEligibility({computational:section(31,1),proof:section(30)},now).status,'ineligible');
 assert.equal(scratchEligibility({computational:section(31,1),proof:section(31,1)},now).status,'complete');
 assert.equal(scratchEligibility({computational:{...section(31,1),disqualified_at:new Date(now).toISOString()},proof:section(31,1)},now).status,'ineligible');
 // The proof scratch deadline starts at the end of solving, not the later proof-file submission.
 assert.equal(scratchEligibility({computational:section(31,1),proof:{...section(1),working_ended_at:new Date(now-31*60000).toISOString()}},now).status,'ineligible');
});
