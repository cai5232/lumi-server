import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGAWA_READ_ONLY_TOOLS, ENGAWA_SERVER_ID, McpClientStore, modelToolsForServer } from "../src/mcp-clients.js";

test("Engawa is injected from its deployment URL and uses the existing MCP settings switch", async (t) => {
  const previousURL = process.env.ENGAWA_MCP_URL;
  process.env.ENGAWA_MCP_URL = "https://engawa.example.test/mcp";
  const directory = await mkdtemp(join(tmpdir(), "lumi-engawa-mcp-test-"));
  t.after(async () => {
    if (previousURL === undefined) delete process.env.ENGAWA_MCP_URL;
    else process.env.ENGAWA_MCP_URL = previousURL;
    await rm(directory, { recursive: true, force: true });
  });

  const store = new McpClientStore(join(directory, "mcp-clients.json"));
  const settings = await store.read();
  const server = settings.servers.find((item) => item.id === ENGAWA_SERVER_ID);
  assert.equal(server.name, "檐廊 Engawa");
  assert.equal(server.url, "https://engawa.example.test/mcp");
  assert.equal(server.enabled, true);
  assert.deepEqual(server.headers, {});
});

test("Engawa URL changes invalidate the cached connection and tool list", async (t) => {
  const previousURL = process.env.ENGAWA_MCP_URL;
  const directory = await mkdtemp(join(tmpdir(), "lumi-engawa-url-test-"));
  t.after(async () => {
    if (previousURL === undefined) delete process.env.ENGAWA_MCP_URL;
    else process.env.ENGAWA_MCP_URL = previousURL;
    await rm(directory, { recursive: true, force: true });
  });
  const store = new McpClientStore(join(directory, "mcp-clients.json"));
  await store.save({ servers: [{
    id: ENGAWA_SERVER_ID, name: "檐廊 Engawa", enabled: true,
    url: "https://old.example.test/mcp", headers: {}, tools: [{ name: "web_read" }],
    connectedAt: "2026-10-11T00:00:00.000Z"
  }] });
  process.env.ENGAWA_MCP_URL = "https://new.example.test/mcp";
  const server = (await store.read()).servers.find((item) => item.id === ENGAWA_SERVER_ID);
  assert.equal(server.url, process.env.ENGAWA_MCP_URL);
  assert.deepEqual(server.tools, []);
  assert.equal(server.connectedAt, null);
});

test("Engawa model calls receive only public read tools while settings retain the full tool list", () => {
  const tools = [...ENGAWA_READ_ONLY_TOOLS, "shelf_add", "shelf_remove", "hobby_add", "hobby_remove"].map((name) => ({ name }));
  assert.deepEqual(modelToolsForServer({ id: ENGAWA_SERVER_ID, tools }).map((tool) => tool.name), ENGAWA_READ_ONLY_TOOLS);
  assert.equal(modelToolsForServer({ id: "other", tools }).length, tools.length);
});
