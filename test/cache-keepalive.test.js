import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startBackend(port, env) {
  const child = spawn(process.execPath, ["src/index.js"], { cwd: new URL("..", import.meta.url), env: { ...process.env, ...env, PORT: String(port) }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`backend exited: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return child;
    } catch { /* Still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error("backend did not start");
}

async function stopBackend(child) {
  if (!child || child.exitCode !== null) return;
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await stopped;
}

test("keepalive reads the old prefix and the next chat reads its assistant prefix", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "lumi-cache-test-"));
  const seen = [];
  const cache = new Set();
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    const body = JSON.parse(raw);
    const plain = body.messages.map((message) => ({ role: message.role, content: typeof message.content === "string" ? message.content : message.content.map((block) => block.text) }));
    const breakpoints = body.messages.flatMap((message, index) =>
      Array.isArray(message.content) && message.content.some((block) => block.cache_control) ? [index] : []);
    const keys = breakpoints.map((index) => JSON.stringify(plain.slice(0, index + 1)));
    const hitKey = keys.filter((key) => cache.has(key)).at(-1);
    const hit = Boolean(hitKey);
    for (const key of keys) cache.add(key);
    seen.push({ plain, breakpoints, keys, hit, hitKey });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "AI 原始回复" } }], usage: { cache_read_input_tokens: hit ? 2048 : 0, cache_creation_input_tokens: hit ? 256 : 2048 } }));
  });
  const providerPort = await listen(provider);
  const port = await freePort();
  const env = {
    LUMI_DATA_DIR: dataDir,
    LUMI_MODEL_API_URL: `http://127.0.0.1:${providerPort}/v1`,
    LUMI_MEMORY_API_URL: `http://127.0.0.1:${providerPort}`,
    LUMI_MODEL_API_KEY: "test",
    LUMI_MODEL_NAME: "anthropic/claude-sonnet-4.6",
    LUMI_CACHE_KEEPALIVE_ENABLED: "true",
    LUMI_CACHE_KEEPALIVE_TOKEN: "test"
  };
  let child;
  try {
    child = await startBackend(port, env);
    const base = `http://127.0.0.1:${port}`;
    const chat = (content, systemPrompt) => fetch(`${base}/v1/chats/default/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, systemPrompt })
    }).then((response) => response.json());
    const first = await chat("第一条消息", "稳定的系统提示词".repeat(500));
    assert.ok(first.assistantMessage, JSON.stringify(first));
    assert.equal(seen.length, 1);
    await stopBackend(child);
    child = undefined;
    const path = join(dataDir, "threads.json");
    const threads = JSON.parse(await readFile(path, "utf8"));
    threads.default.cacheRequestStartedAt = Date.now() - 46 * 60_000;
    await writeFile(path, JSON.stringify(threads));
    child = await startBackend(port, env);
    const keepalive = await fetch(`${base}/v1/internal/cache-keepalive`, {
      method: "POST", headers: { authorization: "Bearer test" }
    }).then((response) => response.json());
    assert.equal(keepalive.hit, true, JSON.stringify(keepalive));
    assert.equal(seen[1].hit, true);
    const assistantKey = seen[1].keys.at(-1);
    assert.deepEqual(seen[1].plain.at(-2).content, [first.assistantMessage.modelContent]);
    await stopBackend(child);
    child = undefined;
    const refreshedThreads = JSON.parse(await readFile(path, "utf8"));
    refreshedThreads.default.cacheKeepaliveAt = Date.now() - 46 * 60_000;
    await writeFile(path, JSON.stringify(refreshedThreads));
    child = await startBackend(port, env);
    const secondKeepalive = await fetch(`${base}/v1/internal/cache-keepalive`, {
      method: "POST", headers: { authorization: "Bearer test" }
    }).then((response) => response.json());
    assert.equal(secondKeepalive.hit, true, JSON.stringify(secondKeepalive));
    assert.equal(seen[2].hitKey, assistantKey, "later keepalives must read the assistant prefix");
    const next = await chat("第二条消息", "稳定的系统提示词".repeat(500));
    assert.ok(next.assistantMessage, JSON.stringify(next));
    assert.equal(seen[3].hit, true);
    assert.equal(seen[3].hitKey, assistantKey, "the next chat must read the assistant prefix");
  } finally {
    await stopBackend(child);
    await new Promise((resolve) => provider.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
