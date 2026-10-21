import test from "node:test";
import assert from "node:assert/strict";
import { finishChatTextStream, sendChatTextResponse, startChatTextStream } from "../src/chat-text-stream.js";

function fakeResponse() {
  return {
    headers: null,
    chunks: [],
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(chunk); },
    end(chunk) { if (chunk) this.chunks.push(chunk); this.ended = true; }
  };
}

test("visual chat stream emits only text before the complete response", async () => {
  const response = fakeResponse();
  const full = { assistantMessage: { content: "你好🌧️世界", thinking: "不显示", toolCalls: [{ name: "lookup" }] }, speechAudioBase64: "audio" };
  await startChatTextStream(response, full.assistantMessage.content, { chunkSize: 2, delayMs: 0 });
  finishChatTextStream(response, full);
  const events = response.chunks.filter(chunk => chunk.startsWith("data:")).map(chunk => JSON.parse(chunk.slice(5).trim()));
  assert.deepEqual(events.slice(0, 3), [
    { type: "text", content: "你好" },
    { type: "text", content: "🌧️世" },
    { type: "text", content: "界" }
  ]);
  assert.deepEqual(events.slice(-2), [{ type: "complete", response: full }, { type: "done" }]);
  assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(response.ended, true);
});

test("replayed streamed responses use the same SSE envelope", async () => {
  const response = fakeResponse();
  const result = { assistantMessage: { content: "完整回复" } };
  await sendChatTextResponse(response, result);
  const events = response.chunks.filter(chunk => chunk.startsWith("data:")).map(chunk => JSON.parse(chunk.slice(5).trim()));
  assert.deepEqual(events, [{ type: "text", content: "完整回复" }, { type: "complete", response: result }, { type: "done" }]);
});

test("HTML-only messages do not get exposed as streamed text", async () => {
  const response = fakeResponse();
  await sendChatTextResponse(response, { assistantMessage: { content: "<html>", contentType: "html" } });
  assert.equal(response.chunks.filter(chunk => chunk.includes('"type":"text"')).length, 0);
});
