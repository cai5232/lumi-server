import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, readFile, writeFile, rename, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { contextSummaryMessages, distillContextBatch } from '../src/context-summary.js';

import { requestInputTokens } from '../src/context-budget.js';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const start = source.indexOf('const compactionRetryAfter = new Map();');
const end = source.indexOf('\nconst backgroundCompactionJobs', start);
const historyStart = source.indexOf('function contextMessages(');
const historyEnd = source.indexOf('\nfunction messageTokens(', historyStart);

async function harness(t, callModel) {
  const dataDir = await mkdtemp(join(tmpdir(), 'lumi-compaction-retry-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const context = { URL, dataDir, join, createHash, randomUUID, mkdir, readFile, writeFile, rename, unlink,
    process: { env: {} }, contextLimitTokens: 380000, console, callModel, historicalModelContent: value => value,
    contextSummaryMessages, requestInputTokens, distillContextBatch,
    estimateTokens: value => requestInputTokens({ system: value }) - 1 };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + source.slice(historyStart, historyEnd), context);
  return context;
}

test('Sonnet 5.5 can send more history and return a larger summary than the old caps', async t => {
  const history = '史'.repeat(450_000);
  const summary = '新摘要'.repeat(5000);
  const context = await harness(t, async request => {
    assert.equal(request.maxOutputTokens, 128_000);
    assert.ok(request.messages[1].content.includes(history));
    assert.equal(request.singleAttempt, true);
    return { content: `<context_summary>${summary}</context_summary>`, finishReason: 'end_turn' };
  });
  const thread = { contextSummary: '之前的摘要' };
  await context.compactContext(thread, { olderMessages: [{ id: 'old', role: 'user', content: history }] },
    { model: 'claude-sonnet-5-5', customProvider: { apiFormat: 'anthropic', url: 'https://api.anthropic.com' } });
  assert.equal(thread.contextSummary, summary);
  assert.equal(thread.compactedThroughMessageId, 'old');
  assert.equal(thread.compactedMessageOffset, 0);
});

test('a Sonnet relay stays within the configured window even when the official model window is larger', async t => {
  const history = '史'.repeat(450_000);
  let calls = 0;
  const context = await harness(t, async request => {
    calls++;
    assert.ok(requestInputTokens(request) + request.maxOutputTokens <= 380_000);
    assert.ok(request.maxOutputTokens > 8192);
    assert.ok(!request.messages[1].content.includes(history));
    return { content: '<context_summary>facts</context_summary>', finishReason: 'end_turn' };
  });
  const thread = { messages: [{ id: 'old', role: 'user', content: history }] };
  await context.compactContext(thread, { olderMessages: thread.messages },
    { model: 'claude-sonnet-5-5', customProvider: { apiFormat: 'anthropic', url: 'https://relay.example' } });
  assert.equal(calls, 1);
  assert.ok(thread.compactedMessageOffset > 180_000);
  assert.ok(thread.compactedMessageOffset < history.length);
  assert.equal(thread.messages[0].content, history);
});

test('one request advances only its own segment, and truncation preserves the saved position', async t => {
  const calls = [];
  const context = await harness(t, async request => {
    calls.push(request);
    return { content: '<context_summary>facts</context_summary>', finishReason: calls.length === 2 ? 'max_tokens' : 'stop' };
  });
  context.contextLimitTokens = requestInputTokens({ messages: contextSummaryMessages('previous', '') }) + 1000;
  const text = '史'.repeat(995) + '😀  ' + '史'.repeat(1600);
  const messages = [{ id: 'long', role: 'user', content: text }, { id: 'tail', role: 'assistant', content: 'recent text' }];
  const thread = { id: 'resume', messages, contextSummary: 'previous' };
  const compress = () => context.compactContext(thread, { olderMessages: context.contextMessages(thread).filter(message => message.id === 'long') },
    { model: 'test', customProvider: {} });

  await compress();
  assert.equal(calls.length, 1);
  assert.equal(thread.compactedThroughMessageId, 'long');
  const firstOffset = thread.compactedMessageOffset;
  assert.ok(firstOffset > 900 && firstOffset < 1000);
  assert.equal(context.contextMessages(thread)[0].content, text.slice(firstOffset));
  assert.ok(!calls[0].messages[1].content.includes('recent text'));
  await assert.rejects(compress(), /did not finish normally/);
  assert.equal(calls.length, 2);
  assert.equal(thread.compactedMessageOffset, firstOffset);
  await compress();
  assert.equal(calls.length, 3);
  assert.ok(calls[2].messages[1].content.includes('😀  史'));
  const nextOffset = thread.compactedMessageOffset;
  assert.equal(context.contextMessages(thread)[0].content, text.slice(nextOffset));
  await compress();
  assert.equal(calls.length, 4);
  assert.equal(thread.compactedMessageOffset, 0);
  assert.equal(context.contextMessages(thread)[0].id, 'tail');
  assert.equal(thread.messages[0].content, text);
});

function installForeground(context, compactContext) {
  const gateStart = source.indexOf('      if (foregroundPlan)');
  const gateEnd = source.indexOf('\n      generated = await generateReply', gateStart);
  Object.assign(context, { foregroundPlan: {}, backgroundCompactionJobs: new Set(), id: 'default',
    threads: { default: {} }, foregroundCompactionAttempted: false, selectedModel: 'test', customProvider: {},
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
