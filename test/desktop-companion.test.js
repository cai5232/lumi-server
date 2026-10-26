import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDesktopCompanionService, filterSensitiveText } from "../src/desktop-companion.js";

const pairingToken = "pairing-token-for-desktop-companion-tests-32-chars";
const secure = true;
const observation = (overrides = {}) => ({
  appName: "Safari",
  bundleIdentifier: "com.apple.Safari",
  windowTitle: "A reading page",
  activityType: "reading",
  selectedText: "A short passage",
  observedAt: new Date().toISOString(),
  ...overrides
});

async function fixture(generate = async () => JSON.stringify({ shouldSpeak: false, content: "", suggestedNextCheckSeconds: 600, reasonCode: "remain_silent" })) {
  const dataDir = await mkdtemp(join(tmpdir(), "lumi-desktop-companion-"));
  const service = createDesktopCompanionService({ dataDir, pairingToken, generate, isSecure: () => true });
  const pairResponse = await service.handle({
    method: "POST", path: "/v1/companion/devices", secure,
    headers: { authorization: `Bearer ${pairingToken}` },
    body: { deviceName: "Test Mac", conversationId: "default" }
  });
  assert.equal(pairResponse.status, 201);
  return {
    dataDir,
    service,
    device: pairResponse.body,
    close: () => rm(dataDir, { recursive: true, force: true })
  };
}

function observeRequest(device, eventId = randomUUID(), value = observation()) {
  return {
    method: "POST", path: "/v1/companion/observe", secure,
    headers: { authorization: `Bearer ${device.deviceToken}` },
    body: { deviceId: device.deviceId, eventId, observation: value }
  };
}

test("companion endpoints require HTTPS and pairing credentials", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "lumi-desktop-companion-"));
  try {
    const service = createDesktopCompanionService({ dataDir, pairingToken, generate: async () => "{}" });
    const insecure = await service.handle({ method: "POST", path: "/v1/companion/devices", secure: false });
    assert.equal(insecure.status, 426);
    const unauthorized = await service.handle({ method: "POST", path: "/v1/companion/devices", secure, body: {} });
    assert.equal(unauthorized.status, 401);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("pairing returns a one-time token while persisting only its hash", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(join(f.dataDir, "desktop-companion.json"), "utf8"));
    assert.equal(state.devices[0].tokenHash.length, 64);
    assert.equal(JSON.stringify(state).includes(f.device.deviceToken), false);
    assert.equal(state.devices[0].conversationId, "default");
  } finally { await f.close(); }
});

test("observation stores no screen text and duplicate event IDs never call the model twice", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls += 1;
    return JSON.stringify({ shouldSpeak: true, content: "这句还挺妙。", suggestedNextCheckSeconds: 10_000, reasonCode: "contextual_comment" });
  });
  try {
    const eventId = randomUUID();
    const value = observation();
    const first = await f.service.handle(observeRequest(f.device, eventId, value));
    assert.equal(first.status, 200);
    assert.equal(first.body.suggestedNextCheckSeconds, 3_600);
    const duplicate = await f.service.handle(observeRequest(f.device, eventId, value));
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(calls, 1);
    const persisted = await readFile(join(f.dataDir, "desktop-companion.json"), "utf8");
    assert.equal(persisted.includes("A short passage"), false);
    assert.equal(persisted.includes("reading page"), false);
    assert.equal(persisted.includes(first.body.content), true);
  } finally { await f.close(); }
});

test("successful observations hand filtered screen context and generated danmaku to the bound chat", async () => {
  let context;
  const dataDir = await mkdtemp(join(tmpdir(), "lumi-desktop-companion-"));
  try {
    const service = createDesktopCompanionService({
      dataDir, pairingToken,
      generate: async () => JSON.stringify({ shouldSpeak: true, content: "这段弹幕跟你看的内容正好接上了。", suggestedNextCheckSeconds: 600, reasonCode: "contextual_comment" }),
      onContext: async value => { context = value; }
    });
    const paired = await service.handle({ method: "POST", path: "/v1/companion/devices", secure, headers: { authorization: `Bearer ${pairingToken}` }, body: { conversationId: "default" } });
    const value = observation({ selectedText: "联系 jane@example.com about the book" });
    const response = await service.handle(observeRequest(paired.body, randomUUID(), value));
    assert.equal(response.status, 200);
    assert.equal(context.conversationId, "default");
    assert.equal(context.observation.selectedText.includes("jane@example.com"), false);
    assert.equal(context.observation.selectedText.includes("[已过滤]"), true);
    assert.equal(context.decision.content, response.body.content);
    assert.ok(context.generatedAt);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("events are scoped to the paired conversation and unexpected fields are rejected", async () => {
  let conversationId = "";
  const f = await fixture(async args => {
    conversationId = args.conversationId;
    return JSON.stringify({ shouldSpeak: false, content: "", suggestedNextCheckSeconds: 600, reasonCode: "remain_silent" });
  });
  try {
    const request = observeRequest(f.device);
    request.body.observation.screenshot = "forbidden";
    assert.equal((await f.service.handle(request)).status, 400);
    const accepted = await f.service.handle(observeRequest(f.device));
    assert.equal(accepted.status, 200);
    assert.equal(conversationId, "default");
  } finally { await f.close(); }
});

test("per-device cooldown and concurrency limit prevent burst generation", async () => {
  let release;
  let calls = 0;
  const f = await fixture(() => new Promise(resolve => {
    calls += 1;
    release = () => resolve(JSON.stringify({ shouldSpeak: false, content: "", suggestedNextCheckSeconds: 600, reasonCode: "remain_silent" }));
  }));
  try {
    const first = f.service.handle(observeRequest(f.device));
    await new Promise(resolve => setTimeout(resolve, 15));
    const concurrent = await f.service.handle(observeRequest(f.device));
    assert.equal(concurrent.status, 409);
    release();
    assert.equal((await first).status, 200);
    const cooldown = await f.service.handle(observeRequest(f.device));
    assert.equal(cooldown.status, 429);
    assert.equal(calls, 1);
  } finally { release?.(); await f.close(); }
});

test("manual force bypasses cooldown but keeps the service request budget", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.handle(observeRequest(f.device))).status, 200);
    assert.equal((await f.service.handle(observeRequest(f.device))).status, 429);
    const forced = observeRequest(f.device);
    forced.body.force = true;
    assert.equal((await f.service.handle(forced)).status, 200);
    const invalid = observeRequest(f.device);
    invalid.body.force = "true";
    assert.equal((await f.service.handle(invalid)).status, 400);
  } finally { await f.close(); }
});

test("malformed model JSON fails closed and is not repaired or repeated for the same event", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls += 1; return '```json\n{"shouldSpeak":true}\n```'; });
  try {
    const eventId = randomUUID();
    const value = observation();
    assert.equal((await f.service.handle(observeRequest(f.device, eventId, value))).status, 503);
    assert.equal((await f.service.handle(observeRequest(f.device, eventId, value))).status, 503);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("device revocation immediately blocks later observations", async () => {
  const f = await fixture();
  try {
    const revoked = await f.service.handle({
      method: "DELETE", path: `/v1/companion/devices/${f.device.deviceId}`, secure,
      headers: { authorization: `Bearer ${pairingToken}` }, body: {}
    });
    assert.equal(revoked.status, 200);
    assert.equal((await f.service.handle(observeRequest(f.device))).status, 401);
  } finally { await f.close(); }
});

test("server-side privacy filter redacts common identifiers and secrets", () => {
  const value = filterSensitiveText("mail jane@example.com card 4111 1111 1111 1111 token=abc123");
  assert.equal(value.includes("jane@example.com"), false);
  assert.equal(value.includes("4111 1111 1111 1111"), false);
  assert.equal(value.includes("abc123"), false);
});

test("backend enforces the per-device hourly generation budget", async () => {
  let timestamp = Date.now();
  const dataDir = await mkdtemp(join(tmpdir(), "lumi-desktop-companion-"));
  try {
    const service = createDesktopCompanionService({
      dataDir, pairingToken, now: () => timestamp,
      generate: async () => JSON.stringify({ shouldSpeak: false, content: "", suggestedNextCheckSeconds: 120, reasonCode: "remain_silent" })
    });
    const paired = await service.handle({ method: "POST", path: "/v1/companion/devices", secure, headers: { authorization: `Bearer ${pairingToken}` }, body: { conversationId: "default" } });
    for (let index = 0; index < 12; index += 1) {
      const value = observation();
      const result = await service.handle(observeRequest(paired.body, randomUUID(), value));
      assert.equal(result.status, 200);
      timestamp += 2 * 60_000 + 1;
    }
    const overBudget = await service.handle(observeRequest(paired.body));
    assert.equal(overBudget.status, 429);
    assert.equal(overBudget.body.error, "request_budget_reached");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
