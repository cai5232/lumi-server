import test from "node:test";
import assert from "node:assert/strict";
import { removeMalformedAnthropicThinkingBlocks } from "../src/anthropic-messages.js";

test("removes malformed thinking blocks while preserving valid blocks and text", () => {
  const messages = [
    { role: "assistant", content: [
      { type: "thinking", signature: "signed-without-thinking" },
      { type: "text", text: "visible reply" },
      { type: "thinking", thinking: "valid reasoning", signature: "sig" }
    ] }
  ];

  assert.deepEqual(removeMalformedAnthropicThinkingBlocks(messages), [
    { role: "assistant", content: [
      { type: "text", text: "visible reply" },
      { type: "thinking", thinking: "valid reasoning", signature: "sig" }
    ] }
  ]);
});

test("drops a message when its only content is a malformed thinking block", () => {
  assert.deepEqual(removeMalformedAnthropicThinkingBlocks([
    { role: "assistant", content: [{ type: "thinking", signature: "missing text" }] },
    { role: "assistant", content: "normal text message" }
  ]), [{ role: "assistant", content: "normal text message" }]);
});

test("leaves valid non-thinking blocks and string messages unchanged", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "user", content: [{ type: "text", text: "image context" }, { type: "image", source: {} }] }
  ];
  assert.deepEqual(removeMalformedAnthropicThinkingBlocks(messages), messages);
});
