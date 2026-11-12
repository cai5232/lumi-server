import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await delay(60);
  }
  assert.fail("Timed out waiting for Lumi");
}

test("chat schedules a real App event, restores it after restart and wakes exactly once", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "lumi-wake-scenes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  let wakes = 0;
  let wakeReport;
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (!req.url.endsWith("/chat/completions")) return res.end("{}");
    const prompt = JSON.parse(raw).messages?.filter(message => message.role === "user").at(-1)?.content || "";
    let content = '{"events":[]}';
    if (String(prompt).includes("<wake_scene_context>")) {
      if (String(prompt).includes("<autonomous_wake_context>")) {
        wakes += 1;
        wakeReport = String(prompt).match(/<wake_scene_context>\n([^\n]+)/)?.[1];
        content = '你打开地图了。<sentinel_decision>{"action":"message","nextWakeMinutes":60}</sentinel_decision>';
      } else {
        content = '等你打开地图我再来找你。<wake_scene_actions>[{"op":"upsert","id":"map","cadenceMin":null,"appOpen":"地图","note":"记得问走哪条路"}]</wake_scene_actions>';
      }
    }
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: {} }));
  });
  const providerPort = await listen(provider);
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const env = {
    ...process.env, PORT: String(port), LUMI_DATA_DIR: directory, LUMI_PUSH_API_TOKEN: "test",
    SENTINEL_INGEST_TOKEN: "event-test", LUMI_TEST_MODEL_TARGET: `http://127.0.0.1:${providerPort}`,
    LUMI_MEMORY_API_URL: `http://127.0.0.1:${providerPort}`, LUMI_CACHE_KEEPALIVE_ENABLED: "false",
    LUMI_PROMISE_ALARM_ENABLED: "false", LUMI_BACKGROUND_PULSE_MS: "120", DUETTO_INTERNAL_PORT: "0"
  };
  delete env.LUMI_APNS_KEY_ID;
  delete env.MURMUR_SERVICE_URL;
  const origin = `http://127.0.0.1:${port}`;
  let server;
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const exit = once(server, "exit");
    server.kill();
    await exit;
  }
  t.after(stop);
  async function start() {
    server = spawn(process.execPath, ["--import", new URL("./mock-model-fetch.js", import.meta.url).pathname, "src/index.js"], {
      cwd: new URL("..", import.meta.url), env, stdio: "ignore"
    });
    await eventually(async () => {
      if (server.exitCode !== null) throw new Error(`Lumi exited with ${server.exitCode}`);
      return fetch(origin + "/health").then(response => response.ok).catch(() => false);
    });
  }
  const request = (path, method = "GET", body, token = "test") => fetch(origin + path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const recordApp = (app, openedAt = new Date().toISOString()) =>
    request("/v1/sentinel/events", "POST", { app, openedAt }, "event-test");

  await start();
  assert.equal((await request("/v1/settings/proactive", "PUT", { enabled: true, intervalMin: 60 })).status, 200);
  assert.equal((await recordApp("地图")).status, 200);
  const chat = await request("/v1/chats/default/messages", "POST", {
    content: "等我下次打开地图时找我", provider: "custom", model: "test-model",
    customProvider: { apiKey: "test", baseURL: "https://model.test/v1", apiFormat: "openai" }
  });
  assert.equal(chat.status, 200, await chat.clone().text());
  assert.equal((await chat.json()).assistantMessage.content, "等你打开地图我再来找你。");
  await stop();
  await start();
  assert.equal((await recordApp("相册")).status, 200);
  await delay(350);
  assert.equal(wakes, 0, "An old or unrelated event must not trigger the scene");
  assert.equal((await recordApp("地图")).status, 200);
  await eventually(async () => {
    const history = await (await request("/v1/chats/default/activity/history")).json();
    return history.events?.some(event => event.title === "情境唤醒");
  });
  assert.deepEqual(JSON.parse(wakeReport).triggers, [{ id: "map", timed: false, app: "地图", note: "记得问走哪条路" }]);
  assert.equal((await recordApp("地图")).status, 200);
  await delay(350);
  assert.equal(wakes, 1);
});
