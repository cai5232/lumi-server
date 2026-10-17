import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const routeSource = source.slice(source.indexOf('async function callProviderRoute('), source.indexOf('\nasync function ', source.indexOf('async function callProviderRoute(') + 1));
const start = source.indexOf('async function generateSleepRadioEpisode(settings) {');
const end = source.indexOf('\n  return episode;\n}', start) + '\n  return episode;\n}'.length;

for (const explicit of [true, false]) {
  test(`sleep radio uses ${explicit ? 'request' : 'saved chat'} route for initial script and continuation`, async () => {
    const calls = [];
    const provider = { baseURL: 'https://example.invalid/v1', apiKey: 'test-only' };
    const route = { provider: 'custom', model: 'chosen-model', customProvider: provider };
    const context = {
      normalizeCustomProvider: value => value,
      resolveMurmurRoute: async (id) => { assert.equal(id, 'default'); return route; },
      readThreads: async () => ({ default: { messages: [], lastChatProvider: 'custom' } }),
      callModel: async options => { calls.push(options); return '静'.repeat(calls.length === 1 ? 1000 : 3000); },
      sleepRadioHanCount: text => (text.match(/\p{Script=Han}/gu) || []).length,
      synthesizeSpeech: async () => ({ audioBase64: Buffer.from('audio').toString('base64') }),
      randomUUID: () => 'test-episode', mkdir: async () => {}, writeFile: async () => {},
      join: (...parts) => parts.join('/'), sleepRadioAudioDir: '/test',
      readSleepRadioEpisodes: async () => [], saveSleepRadioEpisodes: async () => {},
      sendProactivePush: async () => {}, sleepRadioTimeZone: zone => zone || 'UTC',
      Buffer, Intl, Date
    };
    vm.createContext(context);
    vm.runInContext(routeSource + '\n' + source.slice(start, end), context);
    await context.generateSleepRadioEpisode({ ...(explicit ? route : {}), minChars: 4000, timeZone: 'UTC', tts: {} });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.provider, 'custom');
      assert.equal(call.model, 'chosen-model');
      assert.equal(call.customProvider, provider);
    }
  });
}
