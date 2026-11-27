import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {harnessConfig} from '../src/harness-config.js';import {harnessContextPolicy} from '../src/harness-context.js';
const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
function context(){const start=source.indexOf('function preservedChatTail(');const code=source.slice(start,source.indexOf('\nasync function compactContext(',start));
 const config=harnessConfig({LUMI_KIMI_CODE_CONTEXT_TOKENS:'1048576',LUMI_HARNESS_TAIL_MIN_TURNS:'40',LUMI_HARNESS_TAIL_MAX_TURNS:'50',LUMI_HARNESS_TAIL_TARGET_TOKENS:'100000'});
 const c={kimiHarnessConfig:config,harnessContextPolicy,compressionSettings:{snapshot:{triggerTokensEstimate:900000}},contextMessages:t=>t.messages,messageTokens:ms=>ms.length*1000,estimateTokens:t=>t.length,preservedTailMinTurns:10,preservedTailMaxTurns:15,preservedTailTargetTokens:20000};vm.createContext(c);vm.runInContext(code,c);return c;}
const messages=n=>Array.from({length:n*2},(_,i)=>({id:String(i),role:i%2?'assistant':'user',content:'原话'+i}));
test('1M Harness tail selects complete 40–50 turns around the 100K target; API keeps its existing policy',()=>{
 const c=context(),thread={chatRuntime:'kimi-harness',messages:messages(70)},policy=c.preservedTailPolicyForThread(thread);
 assert.equal(c.preservedChatTail(thread.messages,ms=>ms.length*1000,policy).length,100);
 assert.equal(c.preservedChatTail(thread.messages,ms=>ms.length*2000,policy).length,80);
 assert.equal(c.preservedChatTail(thread.messages,ms=>ms.length*10,policy).length,100);
 assert.equal(c.preservedChatTail(thread.messages,undefined,c.preservedTailPolicyForThread({chatRuntime:'api'})).length,20);
 assert.equal(harnessContextPolicy(c.kimiHarnessConfig,{triggerTokensEstimate:900000}).preservedTailTargetTokens,100000);
});
test('increasing retention does not trigger compaction; only crossing 900K does, with the complete archive preserved',()=>{
 const c=context(),thread={chatRuntime:'kimi-harness',lastMeasuredInputTokens:899999,messages:messages(70)};
 assert.equal(c.compactionPlan(thread),null);thread.lastMeasuredInputTokens=900000;
 const plan=c.compactionPlan(thread);assert.equal(plan.olderMessages.length,40);assert.equal(plan.activeContextStartMessageId,'40');assert.equal(thread.messages.length,140);
});
test('large SDK tool transcript with fewer visible turns can compact while retaining every original',()=>{
 const c=context(),thread={chatRuntime:'kimi-harness',lastMeasuredInputTokens:900000,messages:messages(8)};
 const plan=c.compactionPlan(thread);assert.equal(plan.overlapsPreservedTail,true);assert.equal(plan.activeContextStartMessageId,'0');assert.equal(plan.olderMessages.length,16);assert.equal(thread.messages.length,16);
});

test('overlapping summary boundaries cannot remove the raw originals from the next model view',()=>{
 const c=context(),originals=messages(8);const thread={chatRuntime:'kimi-harness',messages:originals,compactedAt:new Date().toISOString(),compactedThroughMessageId:'15',activeContextStartMessageId:'0'};
 assert.equal(c.activeChatMessages(thread).length,16);
 thread.contextExcludedMessageIDs=['2'];assert.equal(c.activeChatMessages(thread).length,15);
});
