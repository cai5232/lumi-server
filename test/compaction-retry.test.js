import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, readFile, writeFile, rename, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { extractCompleteContextSummary, isNormalModelCompletion, distillContextBatch } from '../src/context-summary.js';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const start = source.indexOf('const compactionRetryAfter = new Map();');
const end = source.indexOf('\nconst backgroundCompactionJobs', start);

async function harness(t, callModel) {
  const dataDir = await mkdtemp(join(tmpdir(), 'lumi-compaction-retry-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const context = { dataDir, join, createHash, randomUUID, mkdir, readFile, writeFile, rename, unlink,
    process: { env: {} }, console, callModel, historicalModelContent: value => value,
    extractCompleteContextSummary, isNormalModelCompletion, distillContextBatch };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test('a rejected non-compressing checkpoint is discarded so a later retry can recover', async t => {
  let calls = 0;
  const context = await harness(t, async () => ({
    content: `<context_summary>${++calls === 1 ? 'x'.repeat(15000) : 'concise facts'}</context_summary>`,
    finishReason: 'stop'
  }));
  // Isolate final checkpoint validation from the distiller's own length guard.
  context.distillContextBatch = async (call, input) => {
    const result = await call(input);
    return {summary:extractCompleteContextSummary(result.content),finishReason:result.finishReason};
  };
  const thread = { id: 'retry', messages: [], cacheKeepaliveMessages: ['old-prefix'] };
  const plan = { olderMessages: [{ id: 'old', role: 'user', content: 's'.repeat(16000) }], throughMessageId: 'old' };
  await assert.rejects(context.compactContext(thread, plan, { model: 'test', customProvider: {} }), /non-compression/);
  assert.equal(thread.contextSummary, undefined);
  assert.deepEqual(thread.cacheKeepaliveMessages, ['old-prefix']);
  assert.equal(await context.compactContext(thread, plan, { model: 'test', customProvider: {} }), true);
  assert.equal(calls, 2, 'retry must request a fresh summary instead of replaying the rejected checkpoint');
  assert.equal(thread.contextSummary, 'concise facts');
  assert.equal(thread.cacheKeepaliveMessages, null);
});

test('a truncated later batch preserves history and resumes only the unfinished batch', async t => {
  let calls = 0;
  const context = await harness(t, async () => {
    calls++;
    return { content: '<context_summary>facts</context_summary>', finishReason: calls === 2 || calls === 3 ? 'max_tokens' : 'stop' };
  });
  context.process.env.LUMI_COMPACT_CHUNK_CHARS = '4000';
  const messages = [{ id: 'long', role: 'user', content: 's'.repeat(6000) }];
  const original = JSON.stringify(messages);
  const thread = { id: 'resume', messages, contextSummary: 'previous', compactedThroughMessageId: 'before', cacheKeepaliveMessages: ['prefix'] };
  const plan = { olderMessages: messages, throughMessageId: 'long' };
  await assert.rejects(context.compactContext(thread, plan, { model: 'test', customProvider: {} }), /did not finish normally/);
  assert.equal(thread.contextSummary, 'previous');
  assert.equal(thread.compactedThroughMessageId, 'before');
  assert.deepEqual(thread.cacheKeepaliveMessages, ['prefix']);
  await context.compactContext(thread, plan, { model: 'test', customProvider: {} });
  assert.equal(calls, 4, 'successful first batch must not incur a second model request; only the unfinished batch retries');
  assert.equal(JSON.stringify(messages), original);
  assert.equal(thread.compactedThroughMessageId, 'long');
  assert.equal(thread.cacheKeepaliveMessages, null);
});

function installForeground(context, compactContext) {
  const gateStart = source.indexOf('      if (foregroundPlan)');
  const gateEnd = source.indexOf('\n      generated = await generateReply', gateStart);
  Object.assign(context, { foregroundPlan: {}, backgroundCompactionJobs: new Set(), id: 'default',
    threads: { default: {} }, selectedModel: 'test', customProvider: {},
    persistChatThread: async () => {}, compactContext, projectedInputTokens:0, contextLimitTokens:200000 });
  vm.runInContext(`async function foreground() { ${source.slice(gateStart, gateEnd)} }`, context);
}

function cooldownPath(context) {
  return join(context.dataDir, 'compaction-cooldown-' + createHash('sha256').update('default').digest('hex').slice(0, 24) + '.json');
}

test('foreground respects a persisted background cooldown after process restart', async t => {
  const restarted = await harness(t, () => {});
  await writeFile(cooldownPath(restarted), JSON.stringify({ retryAt: Date.now() + 600000, routeSignature: restarted.compactionRouteSignature("test", {}) }));
  let calls = 0;
  installForeground(restarted, async () => { calls++; throw Error('unexpected summary request'); });
  await restarted.foreground();
  assert.equal(calls, 0, 'a saved cooldown must prevent a paid foreground distillation');
});

test('foreground failure persists cooldown and a new process honors it', async t => {
  const first = await harness(t, () => {});
  let calls = 0;
  const fail = async () => { calls++; throw Error('summary failed'); };
  installForeground(first, fail);
  await first.foreground();
  assert.equal(calls, 1);
  const saved = JSON.parse(await readFile(cooldownPath(first), 'utf8'));
  assert.ok(saved.retryAt > Date.now());
  const restarted = await harness(t, () => {});
  restarted.dataDir = first.dataDir;
  installForeground(restarted, fail);
  await restarted.foreground();
  assert.equal(calls, 1, 'restart must not bypass a foreground failure cooldown');
});


test('changing the model or route bypasses only the old route cooldown', async t => {
 const context = await harness(t, () => {});
 let calls = 0;
 installForeground(context, async () => { calls++; throw Error('old relay failure'); });
 await context.foreground();
 await context.foreground();
 assert.equal(calls, 1);
 context.selectedModel = 'replacement-model';
 await context.foreground();
 assert.equal(calls, 2, 'new model can distill immediately');
 await context.foreground();
 assert.equal(calls, 2, 'failed replacement retains its own cooldown');
 const restarted = await harness(t, () => {});
 restarted.dataDir = context.dataDir;
 installForeground(restarted, async () => { calls++; throw Error('new relay failure'); });
 restarted.selectedModel = 'replacement-model';
 await restarted.foreground();
 assert.equal(calls, 2, 'same-route cooldown survives restart');
 restarted.customProvider = {url:'https://replacement.test/v1',key:'new-key',apiFormat:'anthropic'};
 await restarted.foreground();
 assert.equal(calls, 3, 'new endpoint or credential can recover immediately');
});

test('oversized foreground sends surface the actual summary error and report cooldown', async t => {
 const context = await harness(t, () => {});
 let calls = 0;
 installForeground(context, async () => { calls++; throw Error('HTTP 400: invalid fallback target'); });
 context.threads.default.lastMeasuredInputTokens = 600000;
 await assert.rejects(context.foreground(), error => error.statusCode===503 && /invalid fallback target/.test(error.message));
 await assert.rejects(context.foreground(), /invalid fallback target/);
 assert.equal(calls, 1);
 const diagnostic = vm.runInContext('compactionDiagnostics.get("default")', context);
 assert.equal(diagnostic.status,'cooldown');
 assert.ok(diagnostic.retryAt);
 assert.match(diagnostic.error,/invalid fallback target/);
});
