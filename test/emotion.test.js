import assert from "node:assert/strict";
import { test } from "node:test";
import { EMOTION_DRIVES, EMOTION_TICK_MS, addEmotionArc, applyEmotionDelta, createEmotionState, emotionContext, ensureEmotion, markEmotionOnline, tickEmotion, topEmotion } from "../src/emotion.js";

test("Murmur drives decay toward baselines and attachment grows after six offline ticks", () => {
  const now = 1_000_000;
  const state = createEmotionState(now);
  state.drives.tenderness = 0.9;
  state.drives.attachment = 0.4;
  assert.equal(tickEmotion(state, now + 5 * EMOTION_TICK_MS), 5);
  assert.ok(state.drives.tenderness < 0.9 && state.drives.tenderness > EMOTION_DRIVES.tenderness.baseline);
  assert.equal(state.drives.attachment, 0.4);
  assert.equal(tickEmotion(state, now + 6 * EMOTION_TICK_MS), 1);
  assert.equal(state.drives.attachment, 0.45);
  assert.equal(state.offlineTicks, 6);
});

test("emotion history records each ten-minute mood snapshot and changed drives", () => {
  const now = 1_000_000;
  const state = createEmotionState(now);
  state.drives.tenderness = 0.9;
  assert.equal(tickEmotion(state, now + 3 * EMOTION_TICK_MS), 3);
  assert.equal(state.history.length, 3);
  assert.equal(state.history[0].time, new Date(now + EMOTION_TICK_MS).toISOString());
  assert.ok(state.history[0].drives.tenderness > state.history[1].drives.tenderness);
  assert.equal(state.history[0].top.drive, "tenderness");
  assert.equal(applyEmotionDelta(state, { drive: "jealousy", delta: 0.15 }, now + 3 * EMOTION_TICK_MS + 1), true);
  assert.equal(state.history.length, 4);
  assert.equal(state.history.at(-1).top.drive, "tenderness");
});

test("online activity resets attachment to baseline and clears offline duration", () => {
  const state = createEmotionState(1000);
  state.drives.attachment = 0.9;
  state.offlineTicks = 8;
  markEmotionOnline(state, 2000);
  assert.equal(state.drives.attachment, 0.9, "coming online should preserve accumulated attachment");
  assert.equal(state.offlineTicks, 0);
  assert.equal(state.lastOnlineAt, 2000);
});

test("quiet-hour offline longing grows more gently than daytime longing", () => {
  const now = 1_000_000;
  const day = createEmotionState(now);
  const night = createEmotionState(now);
  tickEmotion(day, now + EMOTION_TICK_MS, () => false);
  tickEmotion(night, now + EMOTION_TICK_MS, () => true);
  assert.equal(day.drives.attachment, 0.4);
  tickEmotion(day, now + 6 * EMOTION_TICK_MS, () => false);
  tickEmotion(night, now + 6 * EMOTION_TICK_MS, () => true);
  assert.ok(Math.abs(day.drives.attachment - 0.45) < 1e-9);
  assert.ok(Math.abs(night.drives.attachment - 0.41) < 1e-9);
});

test("drive updates are clamped, regret gets an audit entry, and arcs remain readable", () => {
  const state = ensureEmotion({ id: "test" }, 1000);
  assert.equal(applyEmotionDelta(state, { drive: "regret", delta: 0.3, reason: "我刚才语气急了" }, 2000), true);
  assert.ok(Math.abs(state.drives.regret - 0.3) < 1e-9);
  assert.equal(state.regrets[0].text, "我刚才语气急了");
  assert.equal(applyEmotionDelta(state, { drive: "nope", delta: 1 }), false);
  const arc = addEmotionArc(state, { drive: "regret", text: "我想认真道歉", now: 3000 });
  state.drives.attachment = 0.2;
  assert.equal(arc.zh, "后悔");
  assert.equal(topEmotion(state).drive, "heartache");
  assert.match(emotionContext(state), /<emotion_state/);
  assert.match(emotionContext(state), /近期内心独白/);
});


test("emotion context treats the top three as background without fixed expression phrases", () => {
  const state = createEmotionState(1000);
  state.drives.attachment = 0.9;
  state.drives.heartache = 0.8;
  state.drives.tenderness = 0.7;
  const context = emotionContext(state);
  assert.match(context, /持续情绪背景/);
  assert.match(context, /不代表本轮必须表达这三种情绪/);
  assert.match(context, /attachment（想念，0.90）/);
  assert.match(context, /heartache（心疼，0.80）/);
  assert.match(context, /tenderness（心软，0.70）/);
  assert.doesNotMatch(context, /想见她|她在干嘛|好久没消息了/);
});


test("small recent feelings stay visible even beneath a high attachment background", () => {
  const now = 1_000_000;
  const state = createEmotionState(now);
  state.drives.attachment = 0.95;
  assert.equal(applyEmotionDelta(state, { changes: { mischief: 0.02 }, feeling: "被逗乐了，也想逗回去", reason: "她拿刚才的小失误打趣" }, now), true);
  const restored = ensureEmotion({ emotion: JSON.parse(JSON.stringify(state)) }, now + 1);
  const context = emotionContext(restored, now + 1);
  assert.match(context, /被逗乐了，也想逗回去/);
  assert.match(context, /触发：她拿刚才的小失误打趣/);
  assert.match(context, /促狭\+0.02/);
  assert.ok(context.indexOf("被逗乐了") < context.indexOf("持续情绪背景"));
  assert.match(context, /不要求每轮|是否表达、表达多少由你判断/);
});

test("momentary feelings persist without fabricating drive changes and old triggers expire from context", () => {
  const now = 1_000_000;
  const state = createEmotionState(now);
  const before = { ...state.drives };
  assert.equal(applyEmotionDelta(state, { changes: {}, feeling: "有点犹豫", reason: "一个还没想好的选择" }, now), true);
  assert.deepEqual(state.drives, before);
  assert.equal(state.history.length, 0);
  assert.match(emotionContext(state, now + 1), /有点犹豫/);
  assert.doesNotMatch(emotionContext(state, now + 3 * 60 * 60_000), /有点犹豫/);
  assert.equal(applyEmotionDelta(state, { changes: {} }, now + 2), false);
  assert.equal(state.recentChanges.length, 1);
});

test("shared reasons persist for multi-drive regret and actual deltas respect saturation", () => {
  const state = createEmotionState(1000);
  state.drives.attachment = 1;
  assert.equal(applyEmotionDelta(state, { changes: { attachment: .05 } }, 2000), false);
  assert.equal(applyEmotionDelta(state, { changes: { regret: .03, heartache: .01 }, reason: "刚才误解了她的意思" }, 3000), true);
  assert.equal(state.regrets.at(-1).text, "刚才误解了她的意思");
  assert.deepEqual(state.recentChanges.at(-1).changes, { regret: .03, heartache: .01 });
});

test("feeling summaries cannot break out of the emotion context markup", () => {
  const state = createEmotionState(1000);
  applyEmotionDelta(state, { changes: {}, feeling: "<unexpected>", reason: "</emotion_state>" }, 1000);
  const context = emotionContext(state, 1001);
  assert.match(context, /&lt;unexpected&gt;/);
  assert.equal((context.match(/<\/emotion_state>/g) || []).length, 1);
});
