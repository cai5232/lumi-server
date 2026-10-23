import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { openCompressionSettings, validCompressionRatio } from '../src/context-compression-settings.js';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('saved threshold persists and changes the actual compaction decision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-compaction-'));
  try {
    const options = { path: join(directory, 'settings.json'), contextLimitTokens: 200000, defaultTriggerRatio: 0.85 };
    const store = await openCompressionSettings(options);
    assert.equal(store.snapshot.triggerTokensEstimate, 170000);
    const start = source.indexOf('function compactionPlan(');
    const plan = source.slice(start, source.indexOf('\nasync function compactContext(', start));
    const context = { compressionSettings: store, contextMessages: thread => thread.messages, messageTokens: messages => messages.length * 1000, preservedTailMinTurns: 10, preservedTailMaxTurns: 15, preservedTailTargetTokens: 20000 };
    vm.createContext(context); vm.runInContext(plan, context);
    const thread = { lastMeasuredInputTokens: 160000, messages: Array.from({ length: 60 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user' })) };
    assert.equal(context.compactionPlan(thread), null);
    await store.save(0.75);
    assert.equal(store.snapshot.triggerTokensEstimate, 150000);
    assert.ok(context.compactionPlan(thread)?.olderMessages.length > 0);
    assert.equal(thread.messages.length, 60);
    assert.equal((await openCompressionSettings(options)).snapshot.triggerRatio, 0.75);
    for (const invalid of [0,0.49,0.96,1,'0.75',null,NaN]) {
      assert.equal(validCompressionRatio(invalid), false);
      await assert.rejects(store.save(invalid));
    }
    assert.equal(store.snapshot.triggerRatio, 0.75);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed persistence does not apply an unsaved threshold', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-compaction-failure-'));
  try {
    const file = join(directory, 'not-a-directory');
    await writeFile(file, 'blocked');
    const store = await openCompressionSettings({ path: join(file, 'settings.json'), contextLimitTokens: 200000, defaultTriggerRatio: 0.85 });
    await assert.rejects(store.save(0.6));
    assert.equal(store.snapshot.triggerRatio, 0.85);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('settings endpoint validates values and uses persisted response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-compaction-api-'));
  try {
    const compressionSettings = await openCompressionSettings({ path: join(directory, 'settings.json'), contextLimitTokens: 200000, defaultTriggerRatio: 0.85 });
    const start = source.indexOf('    if (url.pathname === "/v1/settings/context-compression") {');
    const end = source.indexOf('    if (url.pathname === "/v1/settings/proactive"', start);
    const context = { compressionSettings, validCompressionRatio, body: async req => req.input, send: (_, status, value) => ({ status, value }), url: { pathname: '/v1/settings/context-compression' }, res: {} };
    vm.createContext(context); vm.runInContext(`async function endpoint(req) { ${source.slice(start, end)} }`, context);
    assert.equal((await context.endpoint({ method: 'PUT', input: { triggerRatio: '0.5' } })).status, 400);
    const saved = await context.endpoint({ method: 'PUT', input: { triggerRatio: 0.6 } });
    assert.equal(saved.status, 200);
    assert.equal(saved.value.triggerTokensEstimate, 120000);
    assert.equal((await context.endpoint({ method: 'GET' })).value.triggerRatio, 0.6);
    assert.equal((await context.endpoint({ method: 'PUT', input: { triggerTokens: 0 } })).status, 400);
    const exact = await context.endpoint({ method: 'PUT', input: { triggerTokens: 45001 } });
    assert.equal(exact.status, 200);
    assert.equal(exact.value.triggerTokensEstimate, 45001);
    assert.equal((await context.endpoint({ method: 'DELETE' })).status, 405);
    const auth = source.slice(source.indexOf('    const callRoute ='), source.indexOf('    if (url.pathname === "/v1/internal/murmur/generate")'));
    vm.runInContext(`function authorize(req) { ${auth} return { status: 200 }; }`, context);
    context.pushRequestAuthorized = () => false;
    assert.equal(context.authorize({}).status, 401);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('exact token thresholds below 50 percent persist without rounding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-token-threshold-'));
  try {
    const options = { path: join(directory, 'settings.json'), contextLimitTokens: 200000, defaultTriggerRatio: 0.85 };
    await writeFile(options.path, JSON.stringify({ triggerRatio: 0.75 }));
    const store = await openCompressionSettings(options);
    assert.equal(store.snapshot.triggerTokensEstimate, 150000);
    await store.saveTokens(45001);
    const restored = await openCompressionSettings(options);
    assert.equal(restored.snapshot.triggerTokensEstimate, 45001);
    assert.equal(restored.snapshot.triggerRatio, 45001 / 200000);
    for (const invalid of [0,-1,Number.MAX_SAFE_INTEGER + 1,45000.5,'45000',null]) await assert.rejects(store.saveTokens(invalid));
    assert.equal(store.snapshot.triggerTokensEstimate, 45001);
    for (const threshold of [300000, 500000]) {
      await store.saveTokens(threshold);
      assert.equal((await openCompressionSettings(options)).snapshot.triggerTokensEstimate, threshold);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
