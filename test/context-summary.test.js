import test from "node:test";
import assert from "node:assert/strict";
import { extractCompleteContextSummary, isNormalModelCompletion } from "../src/context-summary.js";

test("accepts only complete non-empty context summaries", () => {
  assert.equal(extractCompleteContextSummary("<context_summary>fact</context_summary>"), "fact");
  assert.equal(extractCompleteContextSummary("  <context_summary version=\"1\"> fact  </context_summary>  "), "fact");
  assert.equal(extractCompleteContextSummary("<context_summary></context_summary>"), null);
  assert.equal(extractCompleteContextSummary("<context_summary>truncated"), null);
  assert.equal(extractCompleteContextSummary("prefix <context_summary>fact</context_summary>"), null);
});

test("recognizes normal completion reasons and rejects truncation", () => {
  for (const reason of ["stop", "STOP", "end_turn", "stop_sequence", "completed"]) {
    assert.equal(isNormalModelCompletion(reason), true, reason);
  }
  for (const reason of ["length", "max_tokens", "pause_turn", "unknown", "", null]) {
    assert.equal(isNormalModelCompletion(reason), false, String(reason));
  }
});

test('malformed normal summary gets one non-streaming repair using the same route and all source text', async () => {
 const {distillContextBatch} = await import('../src/context-summary.js');
 const calls = [], customProvider = {url:'https://relay.test',key:'test'};
 const result = await distillContextBatch(async request => {
  calls.push(request);
  return {content:calls.length===1?'<context_summary>cut off':'<context_summary>complete facts</context_summary>',finishReason:'end_turn'};
 }, {summary:'old facts',chunk:'ALL original material',index:0,total:1,model:'selected',customProvider,maxOutputTokens:25000});
 assert.equal(result.summary, 'complete facts');
 assert.equal(calls.length, 2);
 assert.equal(calls[0].stream, true);
 assert.equal(calls[1].stream, false);
 for (const call of calls) {
  assert.equal(call.customProvider, customProvider);
  assert.equal(call.model, 'selected');
  assert.ok(call.messages[1].content.includes('old facts'));
  assert.ok(call.messages[1].content.includes('ALL original material'));
  assert.equal(call.messages.length, 2);
 }
});

test('empty responses recover once but quota errors never cause extra paid retries', async () => {
 const {distillContextBatch} = await import('../src/context-summary.js');
 const input={summary:'',chunk:'source',index:0,total:1,model:'selected',customProvider:{},maxOutputTokens:25000};
 let calls=0;
 await distillContextBatch(async () => {
  if (++calls === 1) throw Object.assign(Error('empty'),{code:'empty_model_response'});
  return {content:'<context_summary>facts</context_summary>',finishReason:'stop'};
 },input);
 assert.equal(calls,2);
 calls=0;
 await assert.rejects(distillContextBatch(async () => {calls++;throw Object.assign(Error('quota'),{statusCode:502})},input), /quota/);
 assert.equal(calls,1);
 calls=0;
 await assert.rejects(distillContextBatch(async () => {calls++;return {content:'<context_summary>unfinished',finishReason:'end_turn'}},input), /after format retry/);
 assert.equal(calls,2);
});
