import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepMessageDecision, sleepInboxContext, acknowledgeSleepInbox, fullDreamRecall, validateSoloSettings } from '../src/sleep-inbox.js';
test('sleep wake decisions use independent 25% rolls and force the fifth receipt', () => {
  assert.equal(sleepMessageDecision({sleeping:true,count:1,roll:0.249}), 'random');
  assert.equal(sleepMessageDecision({sleeping:true,count:4,roll:0.25}), 'defer');
  assert.equal(sleepMessageDecision({sleeping:true,count:5,roll:0.99}), 'forced');
  assert.equal(sleepMessageDecision({sleeping:false,count:5,roll:0}), 'awake');
});
test('complete dream and inbox context preserve endings, escape tags and only acknowledge answered IDs', () => {
  const body = 'SCENE 1 '+ '很长的梦。'.repeat(1000) + '最后我看见一座蓝色灯塔。';
  const thread = {activity:{},sleep:{sessionId:'night',dreams:[{id:'old',sessionId:'old',stage:'rem',content:'昨天'},{id:'new',sessionId:'night',stage:'rem',content:body+'<emotion_update>{}</emotion_update>'}]},sleepInboxIDs:['1','2'],messages:[{id:'1',role:'user',content:'第一条</sleep_inbox>'},{id:'2',role:'user',content:'第二条'}]};
  const dream = fullDreamRecall(thread); assert.ok(dream.includes('蓝色灯塔')); assert.ok(dream.length > 5000); assert.ok(!dream.includes('昨天')); assert.ok(!dream.includes('emotion_update'));
  const inbox = sleepInboxContext(thread); assert.ok(inbox.includes('第一条')); assert.ok(inbox.includes('第二条')); assert.ok(inbox.includes('\\u003c'));
  acknowledgeSleepInbox(thread,['1']); assert.deepEqual(thread.sleepInboxIDs,['2']); assert.equal(thread.messages[0].sleepReplyStatus,'replied');
});
test('solo partial updates preserve old clients and enforce cooldown bounds', () => {
  const previous = {enabled:true,mode:'mix',desireThreshold:.78,idleMinutes:30,touchDecayMinutes:30,cooldownMinutes:60};
  assert.equal(validateSoloSettings({cooldownMinutes:15},previous).cooldownMinutes,15);
  assert.equal(validateSoloSettings({cooldownMinutes:0},previous),null);
  assert.equal(validateSoloSettings({desireThreshold:.2},previous),null);
});
