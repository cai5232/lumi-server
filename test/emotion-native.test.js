import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EMOTION_DIMENSIONS, createEmotionState, ensureEmotion, emotionContext } from '../src/emotion-native.js';
import { requestMurmurEmotion } from '../src/murmur-native-client.js';

test('native REST calls use the new schema, authentication, and no legacy routes', async () => {
  const previous = process.env.MURMUR_SERVICE_URL;
  process.env.MURMUR_SERVICE_URL = 'http://engine.test/';
  try {
    const payload = { dimensions: { playfulness: .1 }, event_id: 'one' };
    await requestMurmurEmotion('thread/one', 'update', payload, { fetchImpl: async (url, options) => {
      assert.equal(url, 'http://engine.test/emotion/update');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), payload);
      return new Response(JSON.stringify({ applied: { playfulness: .1 }, state: { playfulness: .2 }, mood: 'calm' }));
    } });
    await assert.rejects(requestMurmurEmotion('', 'activate', {}), /unsupported_native/);
    await assert.rejects(requestMurmurEmotion('', 'update', payload, { fetchImpl: async () => new Response('{"ok":true}') }), /acknowledge/);
  } finally {
    if (previous === undefined) delete process.env.MURMUR_SERVICE_URL; else process.env.MURMUR_SERVICE_URL = previous;
  }
});

test('Aria starts fresh and context expresses inclinations without reviving legacy values', () => {
  const state = ensureEmotion({ emotion: { drives: { anger: 1, attachment: 1 } } });
  assert.equal(Object.keys(state.dimensions).length, 8);
  assert.equal(state.dimensions.upset, 0);
  assert.equal(state.dimensions.warmth, .6);
  state.dimensions.upset = .45;
  state.last_input_at = Date.now()/1000 - 3600;
  state.recent_events = [{ trigger: '<injected>test</injected>' }];
  const context = emotionContext(state);
  assert.match(context, /可以暂缓日常主动问候/);
  assert.match(context, /用户的消息仍应被正常接住/);
  assert.match(context, /&lt;injected&gt;/);
  assert.doesNotMatch(context, /attachment|jealousy|fatigue/);
});

test('failed deliveries retain the same event ID and do not apply local dynamics', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const state = createEmotionState();
  let fail = true;
  const sent = [];
  const sandbox = { sharedEmotionState: state, EMOTION_DIMENSIONS, randomUUID: () => 'stable-event', saveEmotionState: async () => {}, console: { warn() {} }, requestMurmurEmotion: async (id, operation, payload) => {
    sent.push(structuredClone(payload));
    if (fail) throw new Error('timeout');
    return { state: { ...state.dimensions, playfulness: .18 }, applied: { playfulness: .08 }, mood: 'calm' };
  } };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('let murmurFlushInFlight = null;'), source.indexOf('\nfunction sleepMemories(')), sandbox);
  await vm.runInContext('applyEmotionUpdateFromOutput(\'<emotion_update>{"dimensions":{"playfulness":0.1},"trigger":"teasing"}</emotion_update>\')', sandbox);
  assert.equal(state.dimensions.playfulness, .1);
  assert.equal(state.pendingMurmurUpdates.length, 1);
  fail = false;
  await vm.runInContext('flushMurmurUpdates()', sandbox);
  assert.equal(state.dimensions.playfulness, .18);
  assert.equal(state.pendingMurmurUpdates.length, 0);
  assert.equal(sent[0].event_id, sent[1].event_id);
  assert.equal(sent[0].source, 'internal');
});
