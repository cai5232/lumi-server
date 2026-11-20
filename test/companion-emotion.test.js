import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrateExpression, companionExpression, directEmotion, mergePerception, silenceContext, toolEmotion } from "../src/companion-emotion.js";
import { readCompanionThought } from "../src/companion-thought.js";

const now = Date.parse("2026-11-20T15:00:00Z");
const message = (content, minutes = 0, role = "user") => ({ role, content, createdAt: new Date(now - minutes * 60_000).toISOString() });

test("context classifier supplements but cannot override direct cues or raise resentment", () => {
  const direct = directEmotion("我爱你。我终于通过了！");
  const outcome = mergePerception(direct, '{"dimensions":{"warmth":-0.3,"upset":0.7,"worry":0.16,"fake":0.2}}');
  assert.deepEqual(outcome.dimensions, { warmth: .11, pride: .12, excitement: .07, worry: .10 });
  assert.deepEqual(mergePerception(direct, "malformed").dimensions, direct.dimensions);
  assert.equal(directEmotion("你根本不尊重我").conflict, true);
  assert.equal(directEmotion("她说“你根本不尊重我”").conflict, false);
  assert.equal(directEmotion("哈哈哈，逗你玩的，你骗我").conflict, false);
  assert.ok(directEmotion("我向你道歉，我们和好吧").dimensions.upset < 0);
});

test("pause, confirmed display and elapsed time have separate meaning", () => {
  const reply = message("我等你回来", 45, "assistant");
  assert.equal(silenceContext([message("晚上聊", 60), { ...reply, foreground: true }], null, now).kind, "absence");
  assert.equal(silenceContext([message("晚上聊", 60), { ...reply, readAt: reply.createdAt }], null, now).kind, "seen_without_reply");
  assert.equal(silenceContext([message("你根本不尊重我", 60), reply], null, now).kind, "conflict_pause");
  assert.equal(silenceContext([reply], message("回来了"), now).kind, "none");
});

test("strong, permission, undertone and conflict paths are exclusive and use recent evidence", () => {
  const worry = { trigger: "确认需要关心", ts: now / 1000 - 90, applied: { worry: .18 } };
  const inputs = { state: { dimensions: { worry: .68, excitement: .64 }, recent_events: [worry] }, history: [], now };
  const strong = companionExpression(inputs);
  assert.equal(strong.next.mode, "strong");
  assert.equal(strong.next.dimension, "worry");
  assert.match(strong.text, /确认需要关心/);
  assert.doesNotMatch(strong.text, /分享你的惊喜/);
  const dip = { ...inputs, state: { ...inputs.state, dimensions: { worry: .55 } } };
  assert.equal(companionExpression(dip).next.mode, "permission");
  assert.equal(companionExpression({ ...dip, previous: strong.next }).next.mode, "strong");
  assert.equal(companionExpression({ ...dip, state: { dimensions: { worry: .17 } } }).next.mode, "undertone");
  assert.equal(companionExpression({ ...inputs, incoming: message("你骗我") }).next.mode, "conflict");
  assert.equal(companionExpression({ ...inputs, state: { ...inputs.state, recent_events: [{ ...worry, ts: worry.ts - 4 * 3600 }] } }).next.mode, "permission");
  const samples = Array.from({ length: 80 }, (_, i) => ({ state: { worry: i / 100 } }));
  assert.ok(calibrateExpression(samples, { worry: 0 }).worry[0] > .5);
  assert.equal(toolEmotion([{ succeeded: true }]), null);
  assert.match(toolEmotion([{ succeeded: false }]).trigger, /1 次/);
});

test("character thoughts separate from visible text, private reasoning and code examples", () => {
  assert.deepEqual(readCompanionThought("<think>PRIVATE</think>[[思考：我还记得那个雨天。]]\n我看见了。"), {
    text: "我还记得那个雨天。", content: "<think>PRIVATE</think>\n我看见了。"
  });
  assert.deepEqual(readCompanionThought("<companion_thought>想说谢谢。</companion_thought>谢谢。"), { text: "想说谢谢。", content: "谢谢。" });
  assert.deepEqual(readCompanionThought("正文\n[[思考：半个标记"), { text: null, content: "正文" });
  const code = "```txt\n[[思考：语法举例]]\n```";
  assert.deepEqual(readCompanionThought(code), { text: null, content: code });
});
