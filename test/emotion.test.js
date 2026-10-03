import assert from "node:assert/strict";
import { test } from "node:test";
import { EMOTION_DRIVES, EMOTION_EXPRESSION_THRESHOLD, EMOTION_TICK_MS, addEmotionArc, applyEmotionDelta, createEmotionState, emotionContext, ensureEmotion, markEmotionOnline, tickEmotion, topEmotion } from "../src/emotion.js";

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

test("high drives add compact Murmur expression cues without sending the full lexicon", () => {
  const state = createEmotionState(1000);
  state.drives.attachment = EMOTION_EXPRESSION_THRESHOLD;
  const high = emotionContext(state);
  assert.match(high, /想见她/);
  assert.match(high, /情绪表达方向/);
  state.drives.attachment = EMOTION_EXPRESSION_THRESHOLD - 0.01;
  const low = emotionContext(state);
  assert.doesNotMatch(low, /情绪表达方向/);
});
