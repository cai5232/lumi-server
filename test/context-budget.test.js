import test from 'node:test';
import assert from 'node:assert/strict';
import { requestInputTokens, assertChatContextBudget, fitChatHistory } from '../src/context-budget.js';

test('counts hidden system, history, tools and tool results in the outgoing request', () => {
 const body = {system:'大'.repeat(50000),messages:[{role:'user',content:[{type:'text',text:'大'.repeat(50000)},{type:'tool_result',content:'大'.repeat(50000)}]}],tools:[{description:'大'.repeat(50000)}]};
 assert.ok(requestInputTokens(body) > 200000);
 assert.throws(() => assertChatContextBudget(body, 200000), error => error.code === 'context_compaction_required');
});

test('cached tokens are still input and measured usage cannot be hidden by a low text estimate', () => {
 const body = {messages:[{role:'user',content:'small'}]};
 assert.throws(() => assertChatContextBudget(body, 200000, 600000), /600000/);
 assert.doesNotThrow(() => assertChatContextBudget(body, 200000, 0));
});

test('image base64 is not mistaken for millions of text tokens', () => {
 const body = {messages:[{role:'user',content:[{type:'image',source:{data:'A'.repeat(2000000)}}]}]};
 assert.ok(requestInputTokens(body) < 2000);
});

test('an oversized archive leaves the summary, latest dialogue, and active tool exchange intact', () => {
  const messages = [
    { role: 'system', content: 'saved summary' },
    { role: 'user', content: '史'.repeat(3_234_257) },
    { role: 'assistant', content: 'archived reply' },
    { role: 'user', content: 'recent question' },
    { role: 'assistant', content: 'recent reply' },
    { role: 'user', content: 'current question' },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'lookup' }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'result' }] }
  ];
  const body = { messages, tools: [{ name: 'lookup' }] };
  const fitted = fitChatHistory(body, 380_000);
  assert.deepEqual(fitted.messages, [messages[0], ...messages.slice(3)]);
  assert.equal(messages.length, 8);
  assert.doesNotThrow(() => assertChatContextBudget({ ...body, messages: fitted.messages }, 380_000));
});
