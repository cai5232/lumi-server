import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestMurmurEmotion } from '../src/murmur-client.js';

test('Murmur updates carry the same event and changes to the authenticated engine', async () => {
  const previousURL = process.env.MURMUR_SERVICE_URL;
  const previousToken = process.env.MURMUR_INTERNAL_TOKEN;
  process.env.MURMUR_SERVICE_URL = 'http://murmur.internal/';
  process.env.MURMUR_INTERNAL_TOKEN = 'test-only';
  try {
    const payload = { event_id: 'reply-1', changes: { mischief: .1 } };
    const result = await requestMurmurEmotion('chat/one', 'update', payload, { fetchImpl: async (url, options) => {
      assert.equal(url, 'http://murmur.internal/internal/v1/chats/chat%2Fone/emotion/update');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer test-only');
      assert.deepEqual(JSON.parse(options.body), payload);
      return new Response(JSON.stringify({ ok: true, state: { drives: { mischief: { v: .3 } } } }));
    } });
    assert.equal(result.state.drives.mischief.v, .3);
    await assert.rejects(requestMurmurEmotion('default', 'update', payload, { fetchImpl: async () => new Response('{}', { status: 503 }) }), /503/);
    await assert.rejects(requestMurmurEmotion('default', 'update', payload, { fetchImpl: async () => new Response('{"ok":true}') }), /acknowledge/);
  } finally {
    if (previousURL === undefined) delete process.env.MURMUR_SERVICE_URL; else process.env.MURMUR_SERVICE_URL = previousURL;
    if (previousToken === undefined) delete process.env.MURMUR_INTERNAL_TOKEN; else process.env.MURMUR_INTERNAL_TOKEN = previousToken;
  }
});
