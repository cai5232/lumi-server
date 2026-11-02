import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { ENGAWA_PHOTO_TOOL, engawaPhotoTool, engawaPhotoCandidates, shareEngawaPhoto, engawaPhotoCard } from '../src/engawa-photos.js';
import { ENGAWA_SERVER_ID, modelToolsForServer } from '../src/mcp-clients.js';
import { relayEndpoint } from '../src/relay-transport.js';
import { responseThinking } from '../src/response-thinking.js';

const imageURL = 'https://apod.nasa.gov/apod/image/2611/nebula.jpg';
const apod = { ok: true, media_type: 'image', title: 'A Nebula', date: '2026-11-02', url: imageURL };
const envelope = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const candidateTrace = data => [{ name: 'apod', succeeded: true, engawaPhotos: engawaPhotoCandidates(envelope(data), 'apod') }];

test('real APOD and artwork results produce photo candidates, but videos and failed MCP calls do not', () => {
  const [photo] = engawaPhotoCandidates(envelope(apod), 'apod');
  assert.equal(photo.imageURL, imageURL);
  assert.equal(photo.sourceURL, 'https://apod.nasa.gov/apod/ap261102.html');
  assert.equal(photo.credit, 'NASA APOD');
  assert.deepEqual(engawaPhotoCandidates(envelope({ ...apod, media_type: 'video' }), 'apod'), []);
  assert.deepEqual(engawaPhotoCandidates({ ...envelope(apod), isError: true }, 'apod'), []);
  assert.deepEqual(engawaPhotoCandidates(envelope({ ...apod, ok: false }), 'apod'), []);
  const [art] = engawaPhotoCandidates({ structuredContent: { ok: true, title: 'Water Lilies', artist: 'Claude Monet', image_url: 'https://openaccess-cdn.clevelandart.org/art.jpg', page_url: 'https://www.clevelandart.org/art/123' } }, 'daily_art');
  assert.equal(art.credit, 'Claude Monet');
  assert.equal(art.sourceURL, 'https://www.clevelandart.org/art/123');
});

test('sharing requires executed Engawa image evidence and rejects arbitrary URLs or unsafe image sources', () => {
  assert.throws(() => shareEngawaPhoto([], { image_url: imageURL }), /本轮没有/);
  assert.throws(() => shareEngawaPhoto(candidateTrace(apod), { image_url: 'https://example.org/invented.jpg' }), /本轮没有/);
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,AA', 'http://example.org/a.jpg', 'https://127.0.0.1/a.jpg', 'https://0x7f000001/a.jpg', 'https://[::1]/a.jpg', 'https://service.internal/a.jpg', 'https://user:secret@example.org/a.jpg']) {
    assert.deepEqual(engawaPhotoCandidates(envelope({ ...apod, url }), 'apod'), []);
  }
  const trace = candidateTrace(apod);
  assert.equal(shareEngawaPhoto(trace, { image_url: imageURL, caption: '叼回来给你看。' }).photo.caption, '叼回来给你看。');
  assert.throws(() => shareEngawaPhoto([...trace, ...Array.from({ length: 4 }, () => ({ name: ENGAWA_PHOTO_TOOL, succeeded: true }))], { image_url: imageURL }), /最多/);
});

test('the card retains selected images, reply and source; escapes HTML and skips failed or duplicate shares', () => {
  const result = shareEngawaPhoto(candidateTrace(apod), { image_url: imageURL, caption: '<script>no</script>' });
  const share = { name: ENGAWA_PHOTO_TOOL, succeeded: true, result: JSON.stringify(result) };
  const card = engawaPhotoCard([share, share, { ...share, succeeded: false }], '想让你看这片星云。');
  assert.equal((card.htmlContent.match(/<img /g) || []).length, 1);
  assert.ok(card.htmlContent.includes(imageURL));
  assert.ok(card.htmlContent.includes('ap261102.html'));
  assert.ok(card.htmlContent.includes('想让你看这片星云。'));
  assert.ok(card.htmlContent.includes('&lt;script&gt;no&lt;/script&gt;'));
  assert.ok(!card.htmlContent.includes('<script>'));
  assert.equal(engawaPhotoCard([{ ...share, succeeded: false }]), null);
});

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function callModel(');
const end = source.indexOf('\nasync function zenMuxSubscriptionUsage', start);
test('autonomous wakes retain the photo card and next wake plan in the saved assistant message', async () => {
  const share = shareEngawaPhoto(candidateTrace(apod), { image_url: imageURL });
  const card = engawaPhotoCard([{ name: ENGAWA_PHOTO_TOOL, succeeded: true, result: JSON.stringify(share) }]);
  const thread = { id: 'default' };
  const settings = { threadId: 'default', intervalMin: 60, actions: { message: true } };
  const context = {
    proactiveSettings: settings, ensureProactive: () => settings, ensureActivity: () => ({}),
    sharedEmotionState: { drives: {} }, canPlaceProactiveCall: () => true,
    resolveMurmurRoute: async () => ({ provider: 'custom', model: 'test', customProvider: {} }),
    generateReply: async options => { assert.equal(options.proactive, true); return { ...card, content: '想给你看。', sentinelDecision: { action: 'message', nextWakeMinutes: 45 } }; },
    normalizeFollowUpDecision: () => null, randomUUID: () => 'photo-wake'
  };
  const wakeStart = source.indexOf('async function generateSentinelWake(');
  const wakeEnd = source.indexOf('\nasync function ', wakeStart + 1);
  vm.createContext(context); vm.runInContext(source.slice(wakeStart, wakeEnd), context);
  const wake = await context.generateSentinelWake(thread);
  assert.equal(wake.message.htmlContent, card.htmlContent);
  assert.equal(wake.message.htmlTitle, card.htmlTitle);
  assert.equal(wake.message.content, '想给你看。');
  assert.equal(wake.nextWakeMinutes, 45);
});

for (const format of ['openai', 'anthropic']) test(`${format} model can browse Engawa, select a real image, and produce a card without a client update`, async () => {
  let round = 0, upstreamCalls = 0;
  const trace = [];
  const context = {
    URL, Date, Math, Map, JSON, Number, String, Array, Boolean, console, process: { env: {} },
    relayEndpoint, responseThinking, removeMalformedAnthropicThinkingBlocks: messages => messages,
    assertChatContextBudget: () => {}, contextLimitTokens: 200000,
    ENGAWA_SERVER_ID, ENGAWA_PHOTO_TOOL, engawaPhotoTool, engawaPhotoCandidates, shareEngawaPhoto, modelToolsForServer,
    mcpClientStore: { read: async () => ({ servers: [{ id: ENGAWA_SERVER_ID, enabled: true, name: '檐廊', tools: [{ name: 'apod', inputSchema: { type: 'object', properties: {} } }] }] }) },
    calendarTools: [], foodTools: [],
    callMcpTool: async (server, name) => { assert.equal(server.id, ENGAWA_SERVER_ID); assert.equal(name, 'apod'); upstreamCalls++; return envelope(apod); },
    cacheMessages: messages => messages, cacheDiagnosticCapture: () => null, recordModelRequest: async () => {}, randomUUID: () => 'test', modelRequestLogJSON: JSON.stringify,
    cacheUsage: () => ({ read: 0, created: 0 }), cacheStats: { modelCalls: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, saveCacheStats: async () => {},
    requestRelay: async options => {
      round++;
      const definitions = options.body.tools;
      const names = definitions.map(tool => tool.name || tool.function.name);
      assert.ok(names.includes(ENGAWA_PHOTO_TOOL));
      if (round === 3) {
        assert.ok(JSON.stringify(options.body.messages).includes('photo_card'));
        return { response: new Response('{}'), data: format === 'anthropic' ? { content: [{ type: 'text', text: '给你叼来一片星云。' }] } : { choices: [{ message: { content: '给你叼来一片星云。' } }] }, requestBody: options.body };
      }
      const name = round === 1 ? names.find(name => name.endsWith('_apod')) : ENGAWA_PHOTO_TOOL;
      const args = round === 1 ? {} : { image_url: imageURL, caption: '想和你一起看。' };
      const data = format === 'anthropic'
        ? { content: [{ type: 'tool_use', id: `tool-${round}`, name, input: args }] }
        : { choices: [{ message: { tool_calls: [{ id: `tool-${round}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
      return { response: new Response('{}'), data, requestBody: options.body };
    }
  };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const result = await context.callModel({ provider: 'custom', model: 'claude-test', customProvider: { url: 'https://relay.example.org/v1', key: 'test', apiFormat: format }, messages: [{ role: 'user', content: '找一张图给我看' }], mcpThreadId: 'default', toolTrace: trace });
  assert.ok(result.includes('给你叼来一片星云。'));
  assert.equal(upstreamCalls, 1);
  assert.equal(trace.length, 2);
  assert.ok(trace.every(call => call.succeeded));
  const card = engawaPhotoCard(trace);
  assert.ok(card.htmlContent.includes(imageURL));
  assert.ok(card.htmlContent.includes('想和你一起看。'));
});
