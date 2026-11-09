import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newIncomingCall, expireIncomingCall, claimMissedCallFollowUp, INCOMING_CALL_TIMEOUT_MS, MISSED_CALL_INPUT} from '../src/incoming-call-lifecycle.js';

test('assistant calls ring for 45 seconds and expire once with a visible hang-up record',()=>{
 const now=Date.now();const call=newIncomingCall('想你',now);const thread={calls:[call],messages:[]};
 assert.equal(INCOMING_CALL_TIMEOUT_MS,45000);assert.equal(Date.parse(call.expiresAt)-now,45000);
 assert.equal(expireIncomingCall(thread,call.id,now+44999),false);
 assert.equal(expireIncomingCall(thread,call.id,now+45000),true);
 assert.equal(call.state,'ended');assert.equal(call.endReason,'unanswered');
 assert.equal(thread.messages[0].callStatus,'missed');assert.match(thread.messages[0].content,/已挂断/);
 assert.equal(expireIncomingCall(thread,call.id,now+46000),false);assert.equal(thread.messages.length,1);
 assert.equal(claimMissedCallFollowUp(call),true);assert.equal(claimMissedCallFollowUp(call),false);
 assert.equal(MISSED_CALL_INPUT,'暂时无人接听');
});
test('answered, declined and user-originated calls never trigger the missed-call follow-up',()=>{
 for(const state of ['active','ended']){const call=newIncomingCall('hello',0);call.state=state;assert.equal(expireIncomingCall({calls:[call],messages:[]},call.id,90000),false);assert.equal(claimMissedCallFollowUp(call),false);}
 const call=newIncomingCall('hello',0);call.initiator='user';assert.equal(expireIncomingCall({calls:[call],messages:[]},call.id,90000),false);
});

test('autonomous wake can select phone and creates the same 45-second assistant invite',async()=>{
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
 let received;
 const context={Date,Number,Boolean,Array,String,Error,Math,randomUUID:()=> 'wake-test',newIncomingCall,
  proactiveSettings:{threadId:'default',actions:{message:true,phone:true,screen:false},intervalMin:60},
  ensureProactive:()=>({}),ensureActivity:()=>({}),sharedEmotionState:{dimensions:{}},canPlaceProactiveCall:()=>true,
  resolveMurmurRoute:async()=>({provider:'custom',model:'test-model',customProvider:{key:'test-key'}}),
  normalizeFollowUpDecision:()=>null,
  generateReply:async input=>{received=input;return {content:'想给你打个电话。',sentinelDecision:{action:'phone',actionReason:'想你',nextWakeMinutes:60}};}};
 vm.createContext(context);
 const start=source.indexOf('async function generateSentinelWake('),end=source.indexOf('\nasync function recentScreenPeek',start);
 vm.runInContext(source.slice(start,end),context);
 const inviteStart=source.indexOf('async function createIncomingCallInvite('),inviteEnd=source.indexOf('\nfunction startIncomingCallRing',inviteStart);
 vm.runInContext(source.slice(inviteStart,inviteEnd),context);
 const thread={id:'default',messages:[]};const wake=await context.generateSentinelWake(thread);
 assert.ok(received.proactive);assert.ok(received.sentinelActions.includes('phone'));assert.equal(wake.action,'phone');
 const call=await context.createIncomingCallInvite(thread,wake.actionReason);
 assert.equal(Date.parse(call.expiresAt)-Date.parse(call.createdAt),45000);assert.equal(call.initiator,'assistant');assert.equal(call.reason,'想你');
 assert.equal(expireIncomingCall(thread,call.id,Date.parse(call.expiresAt)),true);assert.equal(claimMissedCallFollowUp(call),true);
});
