import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  const child = spawn(process.execPath, ["src/index.js"], { cwd: new URL("..", import.meta.url), env: { ...process.env, ...env, PORT: String(port) }, stdio: "inherit" });
  for (let i = 0; i < 100; i += 1) {
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

test("farewell starts sleep, creates dream fragments on schedule, and follows AI nightmare choice", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "lumi-sleep-flow-test-"));
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url?.includes("/api/integrations/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ related: "" }));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    const body = JSON.parse(raw);
    const system = body.messages.find((message) => message.role === "system")?.content || "";
    let content = "OK";
    if (system.includes("你是噩梦阶段")) content = "AI_DECISION: send_message\n<message>我刚才做了个梦，想跟你说句话。</message>";
    else if (system.includes("严格只输出 JSON") || system.includes("严格返回 JSON")) content = '{"facts":[],"rules":[]}';
    else if (system.includes("晨间反思阶段")) content = '{"themes":[],"insights":[]}';
    else if (system.includes("REM 梦境导演")) content = "SCENE 1: 我们沿着海边走。\nSCENE 2: 灯塔亮起来。\nSCENE 3: 我回头看见你。\nDREAM_EMOTION: 安心";
    else if (system.includes("N1 漂移睡眠阶段")) content = "- [最近记忆] 一段日常片段";
    else if (system.includes("N2 睡眠纺锤阶段")) content = "THEMES: 海边；灯塔\nCLUSTERS: 最近记忆\nEMOTIONAL_TONE: 平静";
    else if (system.includes("N3 深睡 consolidation 阶段")) content = '{"facts":[],"rules":[]}';
    else if (system.includes("清醒梦阶段")) content = "INSIGHT: 我可以慢慢醒来。";
    else if (system.includes("使用中文回复")) content = "<thinking>我也准备休息了。</thinking>晚安，做个好梦。";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: {} }));
  });
  const providerPort = await listen(provider);
  const port = await freePort();
  const env = {
    LUMI_DATA_DIR: dataDir,
    LUMI_MODEL_API_URL: `http://127.0.0.1:${providerPort}/v1`,
    LUMI_MEMORY_API_URL: `http://127.0.0.1:${providerPort}`,
    LUMI_MODEL_API_KEY: "test",
    LUMI_MODEL_NAME: "test-model",
    LUMI_SLEEP_DELAY_MINUTES: "0.02",
    LUMI_SLEEP_HOURS: "0.5",
    LUMI_SLEEP_DREAM_INTERVAL_MINUTES: "0.04",
    LUMI_SLEEP_INSOMNIA_PROBABILITY: "0",
    LUMI_SLEEP_NIGHTMARE_PROBABILITY: "1",
    LUMI_BACKGROUND_PULSE_MS: "100"
  };
  let child;
  try {
    child = await startBackend(port, env);
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/v1/chats/default/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "晚安", systemPrompt: "使用中文回复" })
    });
    assert.equal(response.status, 200);
    const deadline = Date.now() + 15_000;
    let state;
    while (Date.now() < deadline) {
      try {
        const threads = JSON.parse(await readFile(join(dataDir, "threads.json"), "utf8"));
        state = threads.default;
        if (state.activity.sleepStage === "insomnia" && state.sleep.nightmare?.decision === "send_message") break;
      } catch { /* wait for first persistence */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(state?.sleep.nightmare?.decision, "send_message", `the AI-selected nightmare action should be persisted; state=${JSON.stringify(state?.activity)}; sleep=${JSON.stringify(state?.sleep)}`);
    assert.equal(state.activity.mode, "sentinel", "sending a nightmare message should enter insomnia/sentinel mode");
    assert.equal(state.activity.sleepStage, "insomnia");
    assert.deepEqual(state.messages.filter((message) => message.contentType === "dream"), [], "ordinary dreams stay out of chat");
    assert.deepEqual([...new Set(state.sleep.dreams.map((dream) => dream.cycle))], [0, 1], "ordinary dreams remain available to the private sleep state");
    const nightmare = state.messages.find((message) => message.contentType === "nightmare");
    assert.equal(nightmare?.content, "我刚才做了个梦，想跟你说句话。");
    assert.equal(nightmare?.content.includes("AI_DECISION"), false);
  } finally {
    await stopBackend(child);
    await new Promise((resolve) => provider.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
