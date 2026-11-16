import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const configuration = { title: "起床", enabled: true, sound: "system", repeat: "daily", hour: 8, minute: 0 };
const allowedNames = ["create_alarm", "delete_alarm", "get_alarm_status", "list_alarms", "update_alarm"];

for (const format of ["openai", "anthropic"]) {
  test(`${format} native alarm tool queues a task on the original provider`, { timeout: 15_000 }, async t => {
    let toolCalls = 0;
    let providerError;
    const relay = createServer(async (req, res) => {
      const chunks = [];
      for await (const piece of req) chunks.push(piece);
      res.setHeader("content-type", "application/json");
      if (!(req.url.endsWith("/messages") || req.url.endsWith("/chat/completions"))) return res.end("{}");
      try {
        const payload = JSON.parse(Buffer.concat(chunks));
        if (payload.model !== "test-alarm-model") return res.end("{}");
        const names = payload.tools.map(tool => tool.name || tool.function.name).filter(name => /_alarms?$|^get_alarm_status$/.test(name));
        assert.deepEqual(names.sort(), allowedNames);
        const recent = payload.messages.at(-1);
        const containsResult = recent.role === "tool" || JSON.stringify(recent.content).includes("tool_result");
        if (containsResult) {
          const detail = format === "openai" ? recent.content : recent.content.find(block => block.type === "tool_result").content;
          assert.equal(JSON.parse(detail).status, "pending");
          return res.end(JSON.stringify(format === "openai"
            ? { choices: [{ message: { content: "闹钟等待手机确认。" } }] }
            : { content: [{ type: "text", text: "闹钟等待手机确认。" }], stop_reason: "end_turn" }));
        }
        toolCalls++;
        return res.end(JSON.stringify(format === "openai" ? {
          choices: [{ message: { role:"assistant", content: null,
            tool_calls: [{ id: "call_alarm", type: "function", function: { name: "create_alarm", arguments: JSON.stringify({ config: configuration }) } }] } }]
        } : { content: [{ type: "tool_use", id: "toolu_alarm", name: "create_alarm", input: { config: configuration } }], stop_reason: "tool_use" }));
      } catch (error) {
        providerError = error;
        res.statusCode = 500;
        return res.end("{}");
      }
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    t.after(() => { relay.closeAllConnections(); relay.close(); });
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const storage = await mkdtemp(join(tmpdir(), "lumi-alarm-tool-"));
    t.after(() => rm(storage, { recursive: true, force:true }));
    const target = `http://127.0.0.1:${relay.address().port}`;
    const app = spawn(process.execPath, ["--import", "./test/mock-model-fetch.js", "src/index.js"], {
      env: { ...process.env, PORT: String(port), LUMI_DATA_DIR: storage, LUMI_PUSH_API_TOKEN: "probe",
        LUMI_MEMORY_API_URL: target, LUMI_TEST_MODEL_TARGET: target, LUMI_CACHE_KEEPALIVE_ENABLED: "false",
        LUMI_PROMISE_ALARM_ENABLED: "false", DUETTO_INTERNAL_PORT: "0" }, stdio: "ignore"
    });
    t.after(async () => {
      if (app.exitCode === null) { const done = once(app, "exit"); app.kill(); await done; }
    });
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 160; i++) {
      if (await fetch(url + "/health").then(r => r.ok).catch(() => false)) { ready = true; break; }
      await delay(50);
    }
    assert(ready);
    const auth = { authorization: "Bearer probe", "content-type": "application/json" };
    const send = (path, body) => fetch(url + path, { method:"POST", headers:auth, body: JSON.stringify(body) });
    const deviceID = randomUUID();
    const registered = await send("/v1/native-alarms/device", { deviceID, authorization:"authorized", timeZone:"Asia/Shanghai", allowAI:true });
    assert.equal(registered.status, 200, await registered.clone().text());
    const response = await send("/v1/chats/default/messages", { content:"明天八点叫我", provider:"custom", model:"test-alarm-model",
      customProvider: { apiKey:"test", baseURL:"https://model.test/v1", apiFormat:format } });
    if (providerError) throw providerError;
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).assistantMessage.content, "闹钟等待手机确认。");
    assert.equal(toolCalls, 1);
    const queue = await (await fetch(url + "/v1/native-alarms", { headers:auth })).json();
    assert.equal(queue.alarms.length, 1);
    assert.equal(queue.alarms[0].confirmed,null);
    const operationID = queue.alarms[0].task.id;
    assert.equal((await send("/v1/native-alarms/claim", { deviceID, operationID })).status, 200);
    assert.equal((await send("/v1/native-alarms/receipt", { deviceID, operationID, status:"applied", ringtone:"system" })).status, 200);
    if (format === "openai") {
      const path = "/v1/native-alarms/mcp";
      const rpc = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });
      const mcp = async (method, params) => {
        const response = await send(path, rpc(method, params));
        assert.equal(response.status, 200);
        return response.json();
      };
      const call = (name, args) => mcp("tools/call", { name, arguments: args });
      const unauthenticated = await fetch(url + path, { method: "POST" });
      assert.equal(unauthenticated.status, 401);
      const crossOrigin = await fetch(url + path, { method: "POST", headers: { ...auth, origin: "https://example.test" } });
      assert.equal(crossOrigin.status, 403);
      assert.equal((await fetch(url + path, { headers: auth })).status, 405);
      assert.equal((await send(path, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
      assert.equal((await mcp("initialize", { protocolVersion: "2025-03-26" })).result.protocolVersion, "2025-03-26");
      assert.deepEqual((await mcp("tools/list")).result.tools.map(tool => tool.name).sort(), allowedNames);
      assert.equal((await call("list_alarms")).result.isError, true);

      const enableAutonomous = await send("/v1/native-alarms/device", { deviceID, authorization: "authorized",
        timeZone: "Asia/Shanghai", allowAI: true, allowAutonomous: true });
      assert.equal(enableAutonomous.status, 200);
      const status = await call("get_alarm_status", { operationID });
      assert.equal(JSON.parse(status.result.content[0].text).status, "applied");

      const args = { operationID: randomUUID(), config: configuration };
      for (let i = 0; i < 2; i++) {
        const queued = JSON.parse((await call("create_alarm", args)).result.content[0].text);
        assert.equal(queued.id, args.operationID);
        assert.equal(queued.status, "pending");
        assert.equal(queued.autonomous, true);
      }
      const list = JSON.parse((await call("list_alarms")).result.content[0].text);
      assert.equal(list.alarms.length, 2);

      const toggle = await fetch(url + "/v1/mcp/servers/lumi-native-alarms", {
        method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false })
      });
      assert.equal(toggle.status, 200);
      assert.equal((await toggle.json()).servers.find(server => server.id === "lumi-native-alarms").enabled, false);
      assert.deepEqual((await mcp("tools/list")).result.tools, []);
      assert.equal((await call("list_alarms")).error.code, -32602);
    }
  });
}
