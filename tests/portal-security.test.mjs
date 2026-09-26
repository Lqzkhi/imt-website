import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedText } from '../src/lib/requestBody.ts';
import { requireSameOrigin } from '../src/lib/requestGuards.ts';

test('JSON body limits enforce streamed bytes and cancel oversized chunked bodies', async () => {
  const body = JSON.stringify({ text: 'π' });
  assert.equal(await readBoundedText(new Request('https://imt.test', { method:'POST', body }), 100), body);
  await assert.rejects(readBoundedText(new Request('https://imt.test', { method:'POST', body:'πππ' }), 5), RangeError);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(100)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readBoundedText(new Request('https://imt.test', {method:'POST', body:stream, duplex:'half'}), 120), RangeError);
  assert.equal(cancelled, true);
});

test('mutations require an exact same origin and reject missing or hostile origins', () => {
  const request = (headers) => new Request('https://www.integratedmath.org/api/test-portal/attempts/start', {method:'POST',headers});
  assert.equal(requireSameOrigin(request({origin:'https://www.integratedmath.org'})),null);
  assert.equal(requireSameOrigin(request({referer:'https://www.integratedmath.org/test-portal'})),null);
  for (const headers of [{},{origin:'null'},{origin:'https://www.integratedmath.org.evil.test'},{origin:'https://evil.test',referer:'https://www.integratedmath.org/'},{referer:'malformed'}]) {
    assert.equal(requireSameOrigin(request(headers)).status,403);
  }
});
