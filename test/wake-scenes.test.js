import assert from "node:assert/strict";
import test from "node:test";
import { applyWakeSceneActions, completeWakeScenes, dueWakeScenes, extractWakeSceneActions, wakeSceneContext } from "../src/wake-scenes.js";

const minute = 60_000;
const now = Date.parse("2026-11-12T12:00:00Z");
const opening = (app, at) => ({ app, openedAt: new Date(at).toISOString() });

test("timer and app event coalesce, while one-shot conditions and notes are consumed only on completion", () => {
  const state = applyWakeSceneActions(undefined, [
    { op: "upsert", id: "outing", kind: "outing", note: "问到家没有", appOpen: "地图" },
    { op: "upsert", id: "music", cadenceMin: null, appOpen: "音乐" }
  ], now);
  const elapsed = now + 30 * minute;
  const events = [opening("地图", now - 1), opening("音乐", elapsed - 100), opening("相册", elapsed - 50)];
  const due = dueWakeScenes(state, events, elapsed);
  assert.deepEqual(due.map(({ scene, timed, app }) => [scene.id, timed, app]), [
    ["outing", true, null], ["music", false, "音乐"]
  ]);
  assert.match(wakeSceneContext(state, due, elapsed), /问到家没有/);
  assert.equal(state.scenes[0].note.remaining, 3);
  const completed = completeWakeScenes(state, due, elapsed);
  assert.equal(completed.scenes[0].nextAt, now + 60 * minute);
  assert.deepEqual(completed.scenes[0].appOpen, { app: "地图", since: now });
  assert.equal(completed.scenes[0].note.remaining, 2);
  const later = elapsed + minute;
  const matched = dueWakeScenes(completed, [opening("地图", later)], later);
  const afterEvent = completeWakeScenes(completed, matched, later);
  assert.equal(afterEvent.scenes[0].appOpen, null);
  assert.equal(afterEvent.scenes[0].nextAt, now + 60 * minute);
  assert.deepEqual(dueWakeScenes(afterEvent, events, later), []);
});

test("snooze, retry, expiry, updating notes, and ending a scene preserve schedule semantics", () => {
  let state = applyWakeSceneActions(undefined, [
    { op: "upsert", id: "work", cadenceMin: 5, durationMin: 20 },
    { op: "upsert", id: "invalid", cadenceMin: 0 },
    { op: "snooze", minutes: 10 }
  ], now);
  assert.deepEqual(dueWakeScenes(state, [], now + 5 * minute), []);
  const due = dueWakeScenes(state, [], now + 10 * minute);
  assert.equal(due.length, 1);
  assert.deepEqual(dueWakeScenes({ ...state, retryAt: now + 11 * minute }, [], now + 10 * minute), []);
  state = applyWakeSceneActions(completeWakeScenes(state, due, now + 10 * minute), [
    { op: "upsert", id: "work", note: "下次再问" }
  ], now + 10 * minute);
  assert.equal(state.scenes[0].note.remaining, 3);
  assert.equal(state.scenes[0].nextAt, now + 15 * minute);
  assert.deepEqual(dueWakeScenes(state, [], now + 20 * minute), []);
  assert.deepEqual(applyWakeSceneActions(state, [{ op: "end", id: "work" }], now + 11 * minute).scenes, []);
});

test("scene protocol is removed from visible output even when malformed", () => {
  assert.deepEqual(extractWakeSceneActions('好。<wake_scene_actions>[{"op":"end","id":"work"}]</wake_scene_actions>'), {
    content: "好。", actions: [{ op: "end", id: "work" }]
  });
  assert.deepEqual(extractWakeSceneActions('好。<wake_scene_actions>[{"op":'), { content: "好。", actions: [] });
});

test("provider reasoning cannot schedule scenes and a repeated event without a timestamp stays old", () => {
  const privateReply = '<thinking><wake_scene_actions>[{"op":"end","id":"work"}]</wake_scene_actions></thinking>好。';
  assert.deepEqual(extractWakeSceneActions(privateReply), { content: privateReply, actions: [] });
  const state = applyWakeSceneActions(undefined, [{ op: "upsert", id: "music", cadenceMin: null, appOpen: "音乐" }], now);
  const report = { app: "音乐", firstSeenAt: new Date(now - 100).toISOString(), createdAt: new Date(now + 100).toISOString() };
  assert.deepEqual(dueWakeScenes(state, [report], now + 100), []);
});
