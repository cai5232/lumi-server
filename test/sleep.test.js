import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveNightmareDecision, shouldTriggerNightmare } from "../src/sleep.js";

test("nightmare probability is not gated by a nonexistent negative-valence score", () => {
  assert.equal(shouldTriggerNightmare({ cycle: 0, alreadyTriggered: false, roll: 0, probability: 1 }), false);
  assert.equal(shouldTriggerNightmare({ cycle: 1, alreadyTriggered: false, roll: 0.2, probability: 0.35 }), true);
  assert.equal(shouldTriggerNightmare({ cycle: 2, alreadyTriggered: true, roll: 0, probability: 1 }), false);
  assert.equal(shouldTriggerNightmare({ cycle: 2, alreadyTriggered: false, roll: 0.8, probability: 0.35 }), false);
});

test("AI decision controls nightmare follow-up and retry outcome is randomized", () => {
  assert.deepEqual(resolveNightmareDecision("AI_DECISION: continue_sleep", 0.2, 0.5), {
    decision: "continue_sleep", reenteredSleep: true, message: ""
  });
  assert.deepEqual(resolveNightmareDecision("AI_DECISION: continue_sleep", 0.8, 0.5), {
    decision: "continue_sleep", reenteredSleep: false, message: ""
  });
  assert.deepEqual(resolveNightmareDecision("AI_DECISION: sentinel", 0, 1), {
    decision: "sentinel", reenteredSleep: false, message: ""
  });
});

test("only an AI-selected message is exposed as the nightmare chat", () => {
  const output = "SCENARIO: 暴雨\n<message>我刚才做了个很乱的梦，想跟你说句话。</message>\nAI_DECISION: send_message\nRECOVERY_PATH: breathe";
  assert.deepEqual(resolveNightmareDecision(output, 0, 0.5), {
    decision: "send_message", reenteredSleep: false, message: "我刚才做了个很乱的梦，想跟你说句话。"
  });
  assert.equal(resolveNightmareDecision("AI_DECISION: send_message", 0, 0.5).message, "");
});
