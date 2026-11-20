import assert from "node:assert/strict";
import { test } from "node:test";
import { userMessageTimingContext, validatedUserSentAt, withUserMessageTimestamp } from "../src/user-message-timing.js";

const now = Date.parse("2026-11-18T18:45:00.000Z");
const at = secondsAgo => new Date(now - secondsAgo * 1000).toISOString();
const message = (id, secondsAgo, fields = {}) => ({ id, role: "user", createdAt: at(secondsAgo), ...fields });

test("autonomous timing ignores assistant replies, background receipts, and invalid timestamps", () => {
  const timing = userMessageTimingContext([
    message("picture", 3900, { contentType: "sticker" }),
    message("older", 5000),
    message("reply", 60, { role: "assistant" }),
    message("unanswered-call", 5, { contentType: "call_status" }),
    message("widget", 4, { contentType: "widget_submission" }),
    message("future", -1),
    message("invalid", 0, { createdAt: "not-a-time" })
  ], { now });
  assert.match(timing, /elapsed_seconds="3900"/);
  assert.match(timing, /1 小时 5 分钟/);
  assert.doesNotMatch(timing, /new_message=/);
});

test("chat shows both the latest message age and the gap before the current message", () => {
  const incoming = message("inbox-current", 5);
  const timing = userMessageTimingContext([incoming, message("previous", 3605)], { incoming, now });
  assert.match(timing, /elapsed_seconds="5" new_message="true"/);
  assert.match(timing, /previous_gap_seconds="3600"/);
  assert.match(timing, /再上一条主动消息相隔 1 小时/);
});

test("a first chat or an empty thread never invents a previous send time", () => {
  assert.match(userMessageTimingContext([], { now }), /status="unknown"/);
  const timing = userMessageTimingContext([], { incoming: message("first", 0), now });
  assert.match(timing, /elapsed_seconds="0"/);
  assert.doesNotMatch(timing, /previous_gap_seconds/);
});

test("each historical user message uses its own validated device or server timestamp", () => {
  const sentAt = validatedUserSentAt("2026-11-19T02:40:00+08:00", now);
  assert.equal(sentAt, at(300));
  assert.equal(validatedUserSentAt(at(-1), now), undefined);
  assert.equal(validatedUserSentAt("not-a-time", now), undefined);
  assert.equal(validatedUserSentAt("2026-11-18", now), undefined);
  const tagged = withUserMessageTimestamp(message("device", 5, { sentAt }), "这条在五分钟前发");
  assert.equal(tagged, `<user_sent_at source="client">${at(300)}</user_sent_at>\n这条在五分钟前发`);
  assert.equal(withUserMessageTimestamp(message("device", 5, { sentAt }), tagged), tagged);
  assert.equal(withUserMessageTimestamp(message("legacy", 80), tagged), `<user_sent_at source="server">${at(80)}</user_sent_at>\n这条在五分钟前发`);
  assert.equal(withUserMessageTimestamp(message("widget", 3, { contentType: "widget_submission" }), "内部状态"), "内部状态");
  assert.match(userMessageTimingContext([message("device", 5, { sentAt })], { now }), /elapsed_seconds="300"/);
});
