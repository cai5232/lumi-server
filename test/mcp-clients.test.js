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

test("Engawa can use the configured same-project Zeabur internal URL without breaking other MCP settings", async (t) => {
  const previousURL = process.env.ENGAWA_MCP_URL;
  process.env.ENGAWA_MCP_URL = "http://engawa-mcp.zeabur.internal:8080/mcp";
  const directory = await mkdtemp(join(tmpdir(), "lumi-engawa-internal-mcp-test-"));
  t.after(async () => {
    if (previousURL === undefined) delete process.env.ENGAWA_MCP_URL;
    else process.env.ENGAWA_MCP_URL = previousURL;
    await rm(directory, { recursive: true, force: true });
  });

  const store = new McpClientStore(join(directory, "mcp-clients.json"));
  await store.save({ servers: [{
    id: "existing-public-mcp", name: "已有 MCP", enabled: true,
    url: "https://mcp.example.test/mcp", headers: {}, tools: [{ name: "existing_tool" }]
  }] });
  let settings = await store.read();
  assert.deepEqual(settings.servers.map(({ id }) => id), ["existing-public-mcp", ENGAWA_SERVER_ID]);
  assert.equal(settings.servers.find(({ id }) => id === ENGAWA_SERVER_ID).url, process.env.ENGAWA_MCP_URL);

  settings = await store.save({ servers: settings.servers.map(server => server.id === ENGAWA_SERVER_ID ? { ...server, enabled: false } : server) });
  assert.equal(settings.servers.find(({ id }) => id === ENGAWA_SERVER_ID).enabled, false);
  assert.equal(settings.servers.find(({ id }) => id === "existing-public-mcp").tools[0].name, "existing_tool");
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

test('background tool discovery cannot restore a server disabled or edited during connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-mcp-discovery-'));
  try {
    const store = new McpClientStore(join(directory, 'clients.json'));
    const original = {id:'custom-discovery',name:'Original',url:'https://example.com/mcp',enabled:true,headers:{},tools:[]};
    await store.save({servers:[original]});
    await store.save({servers:[{...original,enabled:false,name:'Disabled'}]});
    await store.mergeDiscovery([{...original,tools:[{name:'new_tool'}],connectedAt:new Date().toISOString()}]);
    const current = await store.read();
    const server = current.servers.find(item=>item.id===original.id);
    assert.equal(server.enabled,false);assert.equal(server.name,'Disabled');assert.equal(server.tools.length,0);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
