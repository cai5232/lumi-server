import { autonomousContactAllowed, hasAutonomousAction, mergeBackgroundSnapshots } from "../src/background-policy.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createEmotionState, applyEmotionDelta, EMOTION_DRIVES, markEmotionOnline } from '../src/emotion.js';
const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const now = Date.UTC(2026, 9, 22, 13);
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function harness(options = {}) {
  const clock = { now };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  const settings = { enabled: true, threadId: 'default', intervalMin: 30, actions: { message: true, phone: false, screen: false }, ...options.settings };
  let disk = { default: { id: 'default', messages: [], proactive: structuredClone(settings), sleep: { dreams: [], reflections: [], pendingDreams: [], semantic: [], episodic: [] },
    activity: { mode: 'sentinel', lastUserActivityAt: new Date(now - 3 * 3600_000).toISOString(), nextWakeAt: new Date(now - 1).toISOString(), nextWakeSource: 'settings', ...options.activity } } };
  const events = { calls: 0, pushes: [], saves: 0 };
  const context = { Date: Clock, structuredClone, autonomousContactAllowed, hasAutonomousAction, mergeBackgroundSnapshots, Map, Set, Object, Array, Number, String, Boolean, Math, JSON, Promise, console, AbortController, randomUUID,
    EMOTION_DRIVES, process: { env: {} }, backgroundPulseInFlight: false, proactiveSettings: settings,
    proactiveDiagnostics: { checks: 0, attempts: 0 }, sharedEmotionState: createEmotionState(now),
    soloSettings: { enabled: false }, activeChatThreads: new Set(), pendingChatThreads: new Map(), activeSoloRuns: new Map(), soloNextEligibleAt: new Map(), foregroundThreads: new Map(),
    murmurRefreshQueue: Promise.resolve(), sleepGenerationControllers: new Map(), sleepDreamsInFlight: new Set(), sentinelGenerationControllers: new Map(), screenPeekRequests: new Map(), screenPeekFrames: new Map(),
    sleepHours: 8, sleepDelayMinutes: 5, sleepDreamIntervalMinutes: 90,
    readThreads: async () => structuredClone(disk), saveThreads: async value => { events.saves++; disk = structuredClone(value); },
    saveBackgroundThreads: async (updated, original) => { const committed = mergeBackgroundSnapshots(disk, original, updated, id => context.activeChatThreads.has(id)); if (committed.size) events.saves++; return committed; },
    saveProactiveSettings: async () => {}, saveEmotionState: async () => {}, markEmotionOnline,
    sendProactivePush: async (id, message) => { events.pushes.push(message); }, sendIncomingCallPush: async () => {},
    cancelSoloRun: () => {},
    generateSentinelWake: async () => { events.calls++; return { action: 'message', message: { id: randomUUID(), role: 'assistant', content: 'wake', createdAt: new Clock().toISOString() }, nextWakeMinutes: 60, followUp: null }; },
    ...options.context };
  vm.createContext(context);
  vm.runInContext(extract('function ensureProactive(', '\nfunction recordActivityEvent('), context);
  vm.runInContext(extract('function recordActivityEvent(', '\nfunction isFarewell('), context);
  vm.runInContext(extract('async function runBackgroundPulse(', '\nasync function readThreads('), context);
  return { c: context, clock, events, get: () => disk, set: value => { disk = value; } };
}

test('GUARD: overlapping pulses generate and persist only one wake', async () => {
  const gate = deferred(), entered = deferred();
  const h = harness();
  h.c.generateSentinelWake = async () => { h.events.calls++; entered.resolve(); await gate.promise; return { action:'message',message:{id:'one',role:'assistant',content:'one',createdAt:new Date(now).toISOString()},nextWakeMinutes:60 }; };
  const first = h.c.runBackgroundPulse(); await entered.promise;
  await h.c.runBackgroundPulse();
  assert.equal(h.events.calls, 1);
  gate.resolve(); await first;
  assert.equal(h.get().default.messages.length, 1);
  assert.equal(h.events.pushes.length, 1);
  assert.equal(h.c.backgroundPulseInFlight, false);
});

test('GUARD: not-due, sleeping chat lock and recent AI wake guard prevent extra generation', async () => {
  const h = harness({ activity: { nextWakeAt: new Date(now + 60_000).toISOString() } });
  await h.c.runBackgroundPulse(); assert.equal(h.events.calls, 0);
  h.get().default.activity.nextWakeAt = new Date(now - 1).toISOString();
  h.c.activeChatThreads.add('default'); await h.c.runBackgroundPulse(); assert.equal(h.events.calls, 0);
  h.c.activeChatThreads.clear();
  Object.assign(h.get().default.activity, { lastUserActivityAt:new Date(now - 5 * 60_000).toISOString(),nextWakeSource:'ai' });
  await h.c.runBackgroundPulse(); assert.equal(h.events.calls, 0);
  assert.equal(Date.parse(h.get().default.activity.nextWakeAt), now + 25 * 60_000);
});

test('REGRESSION: a follow-up is consumed once and normal scheduling resumes', async () => {
  const h = harness({ activity: { followUp: { minutes: 5, action: 'message' }, nextWakeSource:'follow_up' } });
  await h.c.runBackgroundPulse();
  assert.equal(h.get().default.activity.nextWakeSource, 'ai');
  assert.equal(h.get().default.activity.followUp, null);
  h.clock.now += 5 * 60_000 + 1;
  await h.c.runBackgroundPulse();
  assert.equal(h.events.calls, 1);
  assert.equal(h.get().default.activity.nextWakeSource, 'ai');
  assert.equal(h.get().default.activity.followUp, null);
});

test('REGRESSION: DND prevents both unsolicited model generation and push', async () => {
  const h = harness({ settings:{dnd:true} });
  await h.c.runBackgroundPulse();
  assert.equal(h.events.calls, 0);
  assert.equal(h.events.pushes.length, 0);
});

test('REGRESSION: a stale dream cannot overwrite a completed manual chat', async () => {
  const entered = deferred(), gate = deferred();
  const h = harness({ activity: { mode:'sleeping',sleepUntil:new Date(now + 3600_000).toISOString(),nextDreamAt:new Date(now - 1).toISOString() },
    context:{runSleepDreamSegment:async () => { entered.resolve(); await gate.promise; return null; }} });
  const pulse = h.c.runBackgroundPulse(); await entered.promise;
  assert.equal(h.c.activeChatThreads.has('default'), false, 'dream does not reserve the chat');
  const live = structuredClone(h.get());
  live.default.messages.push({id:'user-live',role:'user',content:'manual user'}, {id:'assistant-live',role:'assistant',content:'manual reply'});
  live.default.activity.mode = 'sentinel';
  h.set(live); // Represents the successfully persisted concurrent chat.
  gate.resolve(); await pulse;
  assert.equal(h.get().default.messages.some(m => m.id === 'user-live'), true);
  assert.equal(h.get().default.activity.mode, 'sentinel');
});

test('GUARD: idle pulse does not tick local emotion or run the disconnected local reflection/push helpers', async () => {
  const h = harness({ activity:{nextWakeAt:new Date(now + 3600_000).toISOString()} });
  h.c.sharedEmotionState.drives.curiosity = .9;
  const before = JSON.stringify(h.c.sharedEmotionState);
  await h.c.runBackgroundPulse();
  assert.equal(JSON.stringify(h.c.sharedEmotionState), before);
  assert.equal((source.match(/\bgenerateEmotionMurmur\(/g)||[]).length, 0);
  assert.equal((source.match(/\bemotionPushDue\(/g)||[]).length, 0);
});

test('REGRESSION: no enabled autonomous actions skips the turn without model generation', async () => {
  const h = harness({ settings:{actions:{message:false,phone:false,screen:false}} });
  let actions;
  h.c.resolveMurmurRoute = async () => ({provider:'custom',model:'test',customProvider:{}});
  h.c.canPlaceProactiveCall = () => true;
  h.c.normalizeFollowUpDecision = () => null;
  h.c.generateReply = async options => { actions = options.sentinelActions; return {content:'fallback'}; };
  vm.runInContext(extract('async function generateSentinelWake(', '\nasync function recentScreenPeek('), h.c);
  const result = await h.c.generateSentinelWake(h.get().default);
  assert.equal(actions, undefined);
  assert.equal(result.action,'skip');
});

test('GUARD: emotion outbox serializes concurrent flushes and retains the same event id on retry', async () => {
  const h = harness(), sent = [];
  h.c.process.env.MURMUR_SERVICE_URL = 'http://engine.test';
  h.c.sharedEmotionState.pendingMurmurUpdates = [{threadID:'default',payload:{event_id:'stable-id',changes:{curiosity:.1}}}];
  const gate = deferred(), entered = deferred(); let fail=true;
  h.c.requestMurmurEmotion = async (id,op,payload) => { sent.push(payload.event_id); entered.resolve(); await gate.promise; if(fail) throw new Error('timeout'); return {}; };
  vm.runInContext(extract('let murmurFlushInFlight = null;', '\nasync function refreshMurmurState('),h.c);
  const a=h.c.flushMurmurUpdates(), b=h.c.flushMurmurUpdates();
  await entered.promise; gate.resolve(); await Promise.allSettled([a,b]);
  assert.equal(sent.length,1);
  assert.equal(h.c.sharedEmotionState.pendingMurmurUpdates.length,1);
  fail=false; await h.c.flushMurmurUpdates();
  assert.deepEqual(sent,['stable-id','stable-id']);
  assert.equal(h.c.sharedEmotionState.pendingMurmurUpdates.length,0);
});

test('REGRESSION: stale remote refresh preserves a newer local emotional delta', async () => {
  const h = harness(), gate=deferred(), entered=deferred();
  h.c.process.env.MURMUR_SERVICE_URL='http://engine.test';
  h.c.flushMurmurUpdates=async()=>{};
  h.c.requestMurmurEmotion=async()=>{entered.resolve();await gate.promise;return {state:{drives:{curiosity:{v:.25}}}};};
  vm.runInContext(extract('function mirrorMurmurState(', '\nasync function flushMurmurUpdates('),h.c);
  vm.runInContext(extract('async function refreshMurmurState(', '\nasync function applyEmotionUpdateFromOutput('),h.c);
  const refresh=h.c.refreshMurmurState('default');await entered.promise;
  applyEmotionDelta(h.c.sharedEmotionState,{changes:{curiosity:.1}},now);
  assert.equal(h.c.sharedEmotionState.drives.curiosity,.35);
  gate.resolve();await refresh;
  assert.equal(h.c.sharedEmotionState.drives.curiosity,.35);
});

test('CHECK: screenshot helper delegates missing custom route recovery to generateReply', async () => {
  const h=harness({settings:{actions:{message:true,phone:false,screen:true}}});let received;
  h.c.screenPeekRequests.set('default',{status:'fallback_sent',requestedAt:now});
  h.c.screenPeekFrames.set('default',{capturedAt:now,mimeType:'image/png',bytes:Buffer.from('test')});
  h.get().default.messages=[{contentType:'screen_peek_missing',screenStatus:'pending',createdAt:new Date(now).toISOString()}];
  h.c.generateReply=async options=>{received=options;throw new Error('route probe');};
  h.c.Buffer=Buffer;
  vm.runInContext(extract('async function completeLateScreenPeek(', '\nasync function describeAutonomousScreen('),h.c);
  await h.c.completeLateScreenPeek('default');
  assert.equal(received.provider,'zenmux');
  assert.equal(received.customProvider,undefined);
  // generateReply itself resolves the persisted route, so this is NOT necessarily a route failure.
  // Record the missing caller route only; don't call it a confirmed defect.
  assert.match(extract('async function generateReply(', '  // Compaction is scheduled'),/resolveMurmurRoute/);
});

 test('REGRESSION: a pending manual chat prevents background reacquisition', async () => {
 const h = harness(); h.c.pendingChatThreads.set('default',1);
 await h.c.runBackgroundPulse(); assert.equal(h.events.calls,0);
 });
 test('REGRESSION: enabling DND during generation discards the wake', async () => {
 const gate=deferred(), entered=deferred(), h=harness();
 h.c.generateSentinelWake=async()=>{entered.resolve(); await gate.promise; return {action:'message',message:{id:'blocked',content:'blocked'},nextWakeMinutes:60};};
 const pulse=h.c.runBackgroundPulse(); await entered.promise;
 h.c.proactiveSettings.dnd=true; gate.resolve(); await pulse;
 assert.equal(h.events.pushes.length,0); assert.equal(h.get().default.messages.length,0);
 });
 test('POLICY: DND blocks all autonomous contact even for nightmare bypass',()=>{
 const t={id:'default'}, settings={threadId:'default',enabled:true,dnd:true,actions:{message:true,phone:true,screen:true}};
 for(const action of ['message','phone','screen']) assert.equal(autonomousContactAllowed(t,settings,action),false);
 assert.equal(autonomousContactAllowed(t,settings,'message',{requireEnabled:false}),false);
 });
