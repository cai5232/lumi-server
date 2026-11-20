import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("the native update reaches the current chat prompt and only character thought reaches the client", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lumi-companion-emotion-"));
  const sequence = [];
  const events = [];
  let modelInput;
  const dimensions = { upset: 0, warmth: .60, curiosity: .15 };
  const relay = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    const send = value => res.end(JSON.stringify(value));
    const path = req.url.split("?")[0];
    if (path === "/emotion/state") return send({ dimensions, mood: "calm", saved_at: Date.now() / 1000 });
    if (path === "/emotion/baselines") return send({ upset: 0, warmth: .60, curiosity: .15 });
    if (path === "/emotion/history") return send(events);
    if (path === "/emotion/update") {
      const event = JSON.parse(raw);
      sequence.push(event.source);
      for (const [key, delta] of Object.entries(event.dimensions)) dimensions[key] = (dimensions[key] || 0) + delta;
      events.push({ ...event, ts: Date.now() / 1000, applied: event.dimensions, state: { ...dimensions } });
      return send({ applied: event.dimensions, state: dimensions, mood: "calm" });
    }
    if (req.method === "GET") return send([]);
    const body = JSON.parse(raw || "{}");
    const last = body.messages?.findLast(message => message.role === "user")?.content || "";
    let content = "{}";
    let reasoning_content;
    if (body.messages?.some(message => /Lumi 情绪感知/.test(message.content))) {
      sequence.push("classification");
      content = '{"dimensions":{"warmth":0.10,"curiosity":0.05,"upset":0.09}}';
    } else if (String(last).includes("<emotion_state")) {
      sequence.push("reply");
      modelInput = last;
      content = '[[思考：她还在意我刚才怎么接了那句话。]]我听见了。<emotion_update>{"dimensions":{"upset":0.2,"pride":0.05},"trigger":"本轮结束后的感受"}</emotion_update>';
      reasoning_content = "provider private text";
    }
    return send({ choices: [{ finish_reason: "stop", message: { content, reasoning_content } }] });
  });
  const relayURL = `http://127.0.0.1:${await listen(relay)}`;
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const backend = spawn(process.execPath, ["--import", new URL("./mock-model-fetch.js", import.meta.url).pathname, "src/index.js"], {
    cwd: new URL("..", import.meta.url), stdio: "ignore",
    env: { ...process.env, PORT: String(port), LUMI_DATA_DIR: folder, LUMI_TEST_MODEL_TARGET: relayURL,
      MURMUR_SERVICE_URL: relayURL, LUMI_MEMORY_API_URL: relayURL, LUMI_PUSH_API_TOKEN: "receipt-test" }
  });
  try {
    for (let i = 0; ; i++) {
      const ready = await fetch(base + "/health").then(response => response.ok, () => false);
      if (ready) break;
      assert.ok(i < 120 && backend.exitCode === null, "backend did not start");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const turn = await fetch(base + "/v1/chats/default/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "你根本不尊重我", provider: "custom", model: "test-model",
        customProvider: { apiKey: "test", baseURL: "https://model.test/v1", apiFormat: "openai" } })
    });
    assert.equal(turn.status, 200);
    const data = await turn.json();
    assert.deepEqual(sequence.slice(0, 3), ["classification", "input", "reply"]);
    assert.deepEqual(events.find(event => event.source === "input").dimensions,
      { upset: 0.15, warmth: -0.09, playfulness: -0.08, curiosity: 0.05 });
    assert.match(modelInput, /<character_voice>[\s\S]*<companion_expression mode="conflict">/);
    assert.ok(modelInput.endsWith("</companion_expression>"));
    assert.equal(data.assistantMessage.thinking, "她还在意我刚才怎么接了那句话。");
    assert.equal(data.assistantMessage.content, "我听见了。");
    const receipt = authorization => fetch(base + "/v1/push/message-read", { method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ threadId: "default", messageId: data.assistantMessage.id.toUpperCase() })
    });
    assert.equal((await receipt("")).status, 401);
    assert.equal((await receipt("Bearer receipt-test")).status, 200);
    const threads = JSON.parse(await readFile(join(folder, "threads.json"), "utf8"));
    assert.ok(threads.default.messages.find(message => message.id === data.assistantMessage.id)?.readAt);
    assert.ok(!JSON.stringify(threads).includes("provider private text"));
  } finally {
    if (backend.exitCode === null) {
      const exit = once(backend, "exit");
      backend.kill();
      await exit;
    }
    await new Promise(resolve => relay.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
