import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFollowUpDecision, wakeIntervalMinutes } from "../src/sentinel-follow-up.js";

test("accepts an enabled message follow-up and maps call to phone", () => {
  assert.deepEqual(
    normalizeFollowUpDecision({ followUpMinutes: 5, followUpAction: "message" }, ["message", "phone"]),
    { minutes: 5, action: "message" }
  );
  assert.deepEqual(
    normalizeFollowUpDecision({ followUpMinutes: 15, followUpAction: "call" }, ["message", "phone"]),
    { minutes: 15, action: "phone" }
  );
});

test("rejects incomplete, out-of-range, and disabled follow-up decisions", () => {
  assert.equal(normalizeFollowUpDecision({ followUpMinutes: 5 }, ["message"]), null);
  assert.equal(normalizeFollowUpDecision({ followUpMinutes: 0, followUpAction: "message" }, ["message"]), null);
  assert.equal(normalizeFollowUpDecision({ followUpMinutes: 1441, followUpAction: "message" }, ["message"]), null);
  assert.equal(normalizeFollowUpDecision({ followUpMinutes: 5, followUpAction: "call" }, ["message"]), null);
  assert.equal(normalizeFollowUpDecision({ followUpMinutes: 5, followUpAction: "screen" }, ["screen"]), null);
});

test("preserves long wake intervals without a scheduling cap", () => {
  assert.equal(wakeIntervalMinutes(240), 240);
  assert.equal(wakeIntervalMinutes(undefined), 50);
  assert.equal(wakeIntervalMinutes(31), 31);
  assert.equal(wakeIntervalMinutes(7 * 24 * 60), 7 * 24 * 60);
  assert.equal(wakeIntervalMinutes(null, 25), 25);
  assert.deepEqual(normalizeFollowUpDecision({ followUpMinutes: 60, followUpAction: "message" }, ["message"]),
    { minutes: 60, action: "message" });
});
