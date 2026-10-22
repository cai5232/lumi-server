import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {extractCompleteContextSummary, isNormalModelCompletion} from '../src/context-summary.js';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function withoutStaleCompactionDirective('), source.indexOf('\nfunction contextMessages(')), context);

test('history drops only generated duplicate summaries and preserves the original transcript', () => {
  const summary = '长期摘要'.repeat(5000);
  const original = `<system_context timezone="Asia/Shanghai">时间\n<context_summary source="system">${summary}</context_summary>\n<retrieved_memories>真实记忆</retrieved_memories>\n</system_context>\n真实用户原文：<context_summary source="system">用户引用</context_summary>`;
  const cleaned = context.historicalModelContent(original);
  assert.ok(!cleaned.includes(summary));
  assert.ok(cleaned.includes('<retrieved_memories>真实记忆</retrieved_memories>'));
  assert.ok(cleaned.endsWith('真实用户原文：<context_summary source="system">用户引用</context_summary>'));
  assert.ok(original.includes(summary));
  assert.equal(context.historicalModelContent(cleaned), cleaned);
  assert.equal(context.historicalModelContent('普通消息'), '普通消息');
  assert.equal(context.historicalModelContent(undefined), undefined);
});

test('a multi-turn legacy history no longer multiplies a 20k summary', () => {
  const summary = 's'.repeat(20000);
  const turns = Array.from({length: 30}, (_, i) => `<system_context><context_summary source="system">${summary}</context_summary></system_context>第${i}轮`);
  const cleaned = turns.map(context.historicalModelContent);
  assert.ok(cleaned.join('').length < 2000);
  assert.ok(cleaned.every((value, i) => value.endsWith(`第${i}轮`)));
});

test('token estimates and compaction batches use the same cleaned history', async () => {
  const summary = 'old-summary'.repeat(5000);
  const messages = [{id:'a',role:'user',content:'原文',modelContent:`<system_context><context_summary source="system">${summary}</context_summary></system_context>原文`}];
  const calls = [];
  const checkpointFiles = new Map();
  Object.assign(context, {process:{env:{}}, console, join, createHash, randomUUID, dataDir:'/fixture',
    readFile:async path => {if(!checkpointFiles.has(path)) throw Object.assign(new Error('missing'),{code:'ENOENT'});return checkpointFiles.get(path);},
    mkdir:async()=>{}, writeFile:async(path,value)=>checkpointFiles.set(path,value),
    rename:async(from,to)=>{checkpointFiles.set(to,checkpointFiles.get(from));checkpointFiles.delete(from);},
    unlink:async path=>checkpointFiles.delete(path), messageTokens:undefined, estimateTokens:value => String(value || '').length,
    callModel:async request => {calls.push(request);return {content:'<context_summary>新摘要</context_summary>', finishReason:'stop'};},
    extractCompleteContextSummary, isNormalModelCompletion});
  vm.runInContext(source.slice(source.indexOf('function messageTokens('), source.indexOf('\nfunction cacheUsage(')), context);
  vm.runInContext(source.slice(source.indexOf('async function compactContext('), source.indexOf('\nconst backgroundCompactionJobs')), context);
  assert.ok(context.messageTokens(messages) < 100);
  const hidden = {role:'assistant',content:'回复',precedingUserModelContent:messages[0].modelContent};
  assert.ok(context.messageTokens([hidden]) > context.messageTokens([{role:'assistant',content:'回复'}]));
  assert.ok(context.messageTokens([hidden]) < 150, 'hidden history is counted after summary deduplication');
  const thread = {contextSummary:'当前摘要',messages};
  await context.compactContext(thread, {olderMessages:messages,throughMessageId:'a'}, {model:'test',customProvider:{}});
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes(summary));
  assert.ok(calls[0].messages[1].content.includes('当前摘要'));
  assert.ok(calls[0].messages[1].content.includes('原文'));
  assert.equal(thread.contextSummary, '新摘要');
  assert.equal(messages[0].modelContent.includes(summary), true);
});
