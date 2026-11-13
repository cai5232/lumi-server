import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp, mkdir, rename, unlink, writeFile, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {extractCompleteContextSummary, isNormalModelCompletion, distillContextBatch, contextSummaryMessages} from '../src/context-summary.js';

import { requestInputTokens } from "../src/context-budget.js";

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

test('token estimates and compaction batches use the same cleaned history', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lumi-history-'));
  t.after(() => rm(dataDir, {recursive:true, force:true}));
  const summary = 'old-summary'.repeat(5000);
  const messages = [{id:'a',role:'user',content:'原文',modelContent:`<system_context><context_summary source="system">${summary}</context_summary></system_context>原文`}];
  const calls = [];
  Object.assign(context, {dataDir, join, createHash, randomUUID, readFile, mkdir, writeFile, rename, unlink, process:{env:{}}, contextLimitTokens:380000, console, messageTokens:undefined, estimateTokens:value => String(value || '').length,
    callModel:async request => {calls.push(request);return {content:'<context_summary>新摘要</context_summary>', finishReason:'stop'};},
    extractCompleteContextSummary, isNormalModelCompletion, distillContextBatch, contextSummaryMessages, requestInputTokens, contextMessages: thread => thread.messages});
  vm.runInContext(source.slice(source.indexOf('function messageTokens('), source.indexOf('\nfunction cacheUsage(')), context);
  vm.runInContext(source.slice(source.indexOf('function compactionMessageBody('), source.indexOf('\nconst backgroundCompactionJobs')), context);
  assert.ok(context.messageTokens(messages) < 100);
  const hidden = {role:'assistant',content:'回复',precedingUserModelContent:messages[0].modelContent};
  assert.ok(context.messageTokens([hidden]) > context.messageTokens([{role:'assistant',content:'回复'}]));
  assert.ok(context.messageTokens([hidden]) < 150, 'hidden history is counted after summary deduplication');
  const executed = [{name:'lookup', arguments:'{}', result:'verified tool output', succeeded:true}];
  messages.push({id:'b',role:'assistant',content:'查到了',toolCalls:executed});
  const thread = {contextSummary:'当前摘要',messages: [...messages, {id:'c',role:'user',content:'近期言言'}, {id:'d',role:'assistant',content:'近期我'}]};
  await context.compactContext(thread, {olderMessages:messages,throughMessageId:'b',tailMessageCount:2}, {model:'test',customProvider:{}});
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes(summary));
  assert.ok(!calls[0].messages[1].content.includes('近期言言'));
  assert.ok(calls[0].messages[1].content.includes('当前摘要'));
  assert.ok(calls[0].messages[1].content.includes('原文'));
  assert.ok(calls[0].messages[1].content.includes(JSON.stringify(executed)), 'compaction must receive the actual tool result');
  for (const label of ['<言言>','</言言>','<我>','</我>']) assert.ok(calls[0].messages[1].content.includes(label));
  assert.ok(!calls[0].messages[1].content.includes('<assistant>'));
  assert.ok(!calls[0].messages[1].content.includes('<user>'));
  assert.equal(thread.contextSummary, '新摘要');
  assert.equal(messages[0].modelContent.includes(summary), true);
});


test('history preserves exact tool outcomes without treating a failed call as success', () => {
  const calls = [{name:'lookup',arguments:'{}',result:'verified fact',succeeded:true},
    {name:'send',arguments:'{}',result:'not executed',succeeded:false}];
  const value = context.historicalModelContent('原始回复', calls);
  assert.ok(value.startsWith('原始回复'));
  assert.ok(value.includes(JSON.stringify(calls)));
  assert.equal(context.historicalModelContent(value, calls), value);
});


test('compaction uses the chat persona, model and emotional section without resending recent history', async () => {
  const { CHAT_SYSTEM_PROMPT } = await import('../src/chat-system-prompt.js');
  let request;
  await distillContextBatch(async value => { request = value; return {content:'<context_summary>【情感与关系】\n- 她很开心</context_summary>', finishReason:'stop'}; },
    {summary:'旧摘要', chunk:'较早聊天', recentContext:'近期聊天', index:0, total:1, model:'chat-model', customProvider:{}, maxOutputTokens:1000});
  assert.ok(request.messages[0].content.startsWith(CHAT_SYSTEM_PROMPT));
  for (const text of ['情感层必须保留', '【情感与关系】', '-今天她的情绪状态', '- 有没有争吵或和解', '- 有没有说过值得记住的话']) assert.ok(request.messages[0].content.includes(text));
  for (const text of ['旧摘要','较早聊天']) assert.ok(request.messages[1].content.includes(text));
  assert.ok(request.messages[0].content.includes('以“我”称呼自己，以“言言”称呼她'));
  assert.ok(!request.messages[1].content.includes('近期聊天'));
  assert.equal(request.singleAttempt, true);
  assert.equal(request.model, 'chat-model');
});
