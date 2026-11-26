import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { DEFAULT_WAKE_MINUTES, SILENT_WAKE_TOKEN, wakeOutcome, wakeSessionScope } from '../src/sentinel-follow-up.js';
const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const extract = name => {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf('\nasync function ', start + 1));
};
function fixture(response = {content:SILENT_WAKE_TOKEN}) {
  const thread = {id:'default', messages:[{id:'old',role:'user',content:'原文'}],activity:{mode:'sentinel',lastUserActivityAt:new Date().toISOString(),nextWakeAt:new Date(Date.now()-1000).toISOString(),nextWakeSource:'ai'}};
  const pushes=[], finalized=[], persisted=[], events=[], compactions=[];
  const settings={enabled:true,threadId:'default',intervalMin:18,intervalMax:18,actions:{message:true,phone:false,screen:false}};
  const receipt={key:'default:chat',runId:'turn'};
  let generations=0;
  const context={
    Date, AbortController, console, DEFAULT_WAKE_MINUTES,wakeOutcome,
    backgroundPulseInFlight:false,proactiveSettings:settings, proactiveDiagnostics:{checks:0,attempts:0},
    activeChatThreads:new Set(),pendingForegroundChats:new Set(),foregroundCalls:new Set(),sentinelGenerationControllers:new Map(),
    sharedEmotionState:{drives:{}},soloSettings:{enabled:false},screenPeekRequests:new Map(),
    ensureActivity:t=>t.activity,ensureProactive:()=>settings,availableChatHistory:t=>t.messages,
    activeWakeScenes:()=>[],isFarewell:()=>false,canPlaceProactiveCall:()=>false,
    readThreads:async()=>({default:thread}),persistChatThread:async(id,t)=>persisted.push(structuredClone(t)),
    resolveMurmurRoute:async()=>({provider:'custom',model:'test',customProvider:{runtime:'kimi-harness'}}),
    generateReply:async opts=>{generations++;assert.ok(opts.sentinelActions.includes('none'));return {...response,harnessReceipt:receipt,measuredInputTokens:1234};},
    randomUUID:()=> 'wake-message',
    recordActivityEvent:(t,kind,title,content)=>{const event={kind,title,content};events.push(event);return event;},
    finishWakeRecord:()=>{},completeWakeScenes:s=>s,
    kimiHarness:{finalize:async(...args)=>finalized.push(args)},
    modelChatMessages:t=>t.messages,historyFingerprint:()=> 'unchanged-checkpoint',
    scheduleBackgroundCompaction:(...args)=>compactions.push(args),
    saveProactiveSettings:async()=>{},sendProactivePush:async(...args)=>pushes.push(args)
  };
  vm.createContext(context);
  vm.runInContext(extract('generateSentinelWake')+'\n'+extract('runBackgroundPulse'),context);
  return {context,thread,pushes,finalized,persisted,events,compactions,settings,generations:()=>generations};
}

test('silent protocol accepts codeword or none, ignores thinking mentions, fixes interval and disables model follow-ups',()=>{
  for(const generated of [{silentWake:true,content:'',htmlContent:SILENT_WAKE_TOKEN},{content:SILENT_WAKE_TOKEN},{content:'正文'+SILENT_WAKE_TOKEN,sentinelDecision:{action:'message'}},{content:'ignored',sentinelDecision:{action:'none',nextWakeMinutes:999,followUpMinutes:1,followUpAction:'message'}}]) {
    assert.deepEqual(wakeOutcome(generated,['message','none']),{action:'none',nextWakeMinutes:18,followUp:null,silent:true});
  }
  assert.equal(wakeOutcome({content:'想给你看看',modelContent:`<thinking>${SILENT_WAKE_TOKEN}</thinking>想给你看看`},['message','none']).action,'message');
  assert.equal(wakeOutcome({content:'不要打扰'},['none']).action,'none');
});

test('quiet wake persists and finalizes existing Session without a chat message, fallback greeting or push; next pulse does not generate again',async()=>{
  const f=fixture();const original=structuredClone(f.thread.messages);
  const now=Date.now();await f.context.runBackgroundPulse();
  assert.equal(f.generations(),1);assert.deepEqual(f.thread.messages,original);
  assert.equal(f.pushes.length,0);assert.equal(f.persisted.length,1);assert.equal(f.finalized.length,1);
  assert.equal(f.finalized[0][0].key,'default:chat');
  assert.ok(Date.parse(f.thread.activity.nextWakeAt)>=now+18*60000);
  assert.ok(Date.parse(f.thread.activity.nextWakeAt)<=Date.now()+18*60000);
  assert.equal(f.context.proactiveDiagnostics.lastReason,'silent_wake');
  assert.ok(!JSON.stringify(f.persisted).includes(SILENT_WAKE_TOKEN));
  assert.equal(f.compactions.length,1,'keep normal application compaction checks after silent turns');
  await f.context.runBackgroundPulse();assert.equal(f.generations(),1);
  // A restored scheduler reads the persisted due time rather than resetting it.
  const restarted=fixture();Object.assign(restarted.thread,f.persisted[0]);
  await restarted.context.runBackgroundPulse();assert.equal(restarted.generations(),0);
});

test('normal wake still delivers one real message and ignores model-proposed time/follow-up',async()=>{
  const f=fixture({content:'刚刚看到了好看的云。',sentinelDecision:{action:'message',nextWakeMinutes:2,followUpMinutes:1,followUpAction:'message'}});
  await f.context.runBackgroundPulse();
  assert.equal(f.thread.messages.length,2);assert.equal(f.thread.messages.at(-1).content,'刚刚看到了好看的云。');
  assert.equal(f.pushes.length,1);assert.equal(f.thread.activity.followUp,null);
  assert.ok(Date.parse(f.thread.activity.nextWakeAt)>Date.now()+17*60000);
  assert.equal(f.finalized.length,1);
});

test('foreground requests and sleep suppress overlapping wakes; DND warms silently without delivering',async()=>{
  for(const blocked of ['foreground','sleep']) {
    const f=fixture();if(blocked==='foreground')f.context.activeChatThreads.add('default');else f.thread.activity.mode='sleeping';
    await f.context.runBackgroundPulse();assert.equal(f.generations(),0);
  }
  const f=fixture({content:'想发消息',sentinelDecision:{action:'message'}});f.settings.dnd=true;
  await f.context.runBackgroundPulse();assert.equal(f.generations(),1);assert.equal(f.thread.messages.length,1);assert.equal(f.pushes.length,0);
});

test('provider failure retains history and waits 18 minutes without a paid fallback',async()=>{
  const f=fixture();f.context.generateReply=async()=>{throw Error('selected-provider-failed');};
  await f.context.runBackgroundPulse();assert.equal(f.thread.messages.length,1);assert.equal(f.pushes.length,0);
  assert.ok(Date.parse(f.thread.activity.nextWakeAt)>Date.now()+17*60000);
});

test('SDK wake shares primary chat Session scope; calls, desktop and native ACP retain their scopes',()=>{
  assert.equal(wakeSessionScope({proactive:true,runtime:'kimi-harness'}),'chat');
  assert.equal(wakeSessionScope({proactive:false,runtime:'kimi-harness'}),'chat');
  assert.equal(wakeSessionScope({proactive:true,runtime:'kimi-acp'}),'wake');
  assert.equal(wakeSessionScope({callMode:true,runtime:'kimi-harness'}),'call');
  assert.equal(wakeSessionScope({desktopCompanion:true,runtime:'kimi-harness'}),'desktop');
});
