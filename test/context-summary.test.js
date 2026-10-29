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


test('max_tokens retries the same full material with a smaller summary target, never accepting partial output', async () => {
 const {distillContextBatch} = await import('../src/context-summary.js');
 const calls=[];
 const result=await distillContextBatch(async request=>{
  calls.push(request);
  return calls.length===1 ? {content:'<context_summary>partial-not-to-reuse',finishReason:'max_tokens'}
   : {content:'<context_summary>complete concise facts</context_summary>',finishReason:'end_turn'};
 },{summary:'all previous facts',chunk:'all new original material',index:1,total:8,model:'selected',customProvider:{},maxOutputTokens:25000});
 assert.equal(result.summary,'complete concise facts');
 assert.equal(calls.length,2);
 assert.ok(calls[0].messages[1].content.includes('6000'));
 assert.ok(calls[1].messages[1].content.includes('3000'));
 for(const request of calls){
  assert.ok(request.messages[1].content.includes('all previous facts'));
  assert.ok(request.messages[1].content.includes('all new original material'));
  assert.ok(!JSON.stringify(request).includes('partial-not-to-reuse'));
  assert.equal(request.maxOutputTokens,25000,'do not solve runaway summaries by raising paid output budget');
  assert.equal(request.disableThinkingRetry,true);
 }
});

test('a complete but growing summary is refined before it can inflate the next batch', async () => {
 const {distillContextBatch} = await import('../src/context-summary.js');
 let calls=0;
 const result=await distillContextBatch(async()=>({content:`<context_summary>${++calls===1?'x'.repeat(7000):'merged facts'}</context_summary>`,finishReason:'stop'}),
 {summary:'previous facts',chunk:'new facts',index:0,total:2,model:'selected',customProvider:{},maxOutputTokens:25000});
 assert.equal(result.summary,'merged facts');assert.equal(calls,2);
 calls=0;
 await assert.rejects(distillContextBatch(async()=>{calls++;return {content:'<context_summary>partial',finishReason:'max_tokens'}},
 {summary:'previous facts',chunk:'new facts',index:0,total:2,model:'selected',customProvider:{},maxOutputTokens:25000}), /after concise retry/);
 assert.equal(calls,2,'persistent truncation must stop without committing partial facts');
});
