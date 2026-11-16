import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNativeAlarms } from "../src/native-alarms.js";

const deviceID = randomUUID();
const register = { deviceID, authorization: "authorized", timeZone: "America/New_York",
  allowAI: true, allowAutonomous: false, pushToken: "a".repeat(64), pushEnvironment: "sandbox" };
const morning = { title: "起床", enabled: true, sound: "voice", repeat: "weekdays", hour: 8, minute: 15 };

async function fixture(t, clock = Date.now) {
  const dir = await mkdtemp(join(tmpdir(), "lumi-native-alarms-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "queue.json");
  return [openNativeAlarms(path, clock), path];
}

test("queued work survives a restart and only a device receipt arms the alarm", async t => {
  const [store, path] = await fixture(t);
  await store.register(register);
  const options = { source: "ai", operationID: randomUUID() };
  const task = await store.mutate({ kind: "create", config: morning }, options);
  assert.equal(task.status, "pending");
  assert.deepEqual(task.config.weekdays, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal((await store.get()).alarms[0].confirmed, null);
  assert.equal((await store.pushTarget()).environment, "sandbox");

  const rebooted = openNativeAlarms(path);
  assert.equal((await rebooted.mutate({ kind: "create", config: morning }, options)).id, task.id);
  await assert.rejects(rebooted.mutate({ kind: "create", config: { ...morning, hour: 9 } }, options), { statusCode: 409 });
  await assert.rejects(rebooted.claim(randomUUID(), task.id), { statusCode: 403 });
  assert.equal((await rebooted.claim(deviceID.toUpperCase(), task.id.toUpperCase())).status, "applying");
  await assert.rejects(rebooted.mutate({ kind: "delete", alarmID: task.alarmID, expectedRevision: 1 }, { source: "ai" }), { statusCode: 409 });

  const receipt = { status: "applied", ringtone: "fallback" };
  await rebooted.receipt(deviceID, task.id, receipt);
  assert.equal((await rebooted.status(task.id)).confirmed.armed, true);
  assert.equal((await rebooted.status(task.id)).confirmed.ringtone, "fallback");
  assert.equal((await rebooted.receipt(deviceID, task.id, receipt)).status, "applied");
  await rebooted.observe(deviceID, [{ alarmID: task.alarmID, physicalID: task.id, armed: false }]);
  assert.equal((await rebooted.get()).alarms[0].confirmed.armed, false);
});

test("permission scopes, queued replacement, offline expiry, and update conflicts", async t => {
  let current = Date.parse("2026-03-01T12:00:00Z");
  const [store] = await fixture(t, () => current);
  await store.register(register);
  await assert.rejects(store.mutate({ kind: "create", config: morning }, { source: "ai", autonomous: true }), { statusCode: 403 });
  const task = await store.mutate({ kind: "create", config: morning }, { source: "ai" });
  const manual = { source: "user", deviceID };
  const next = await store.mutate({ kind: "update", alarmID: task.alarmID, expectedRevision: 1,
    config: { ...morning, hour: 9 } }, manual);
  assert.equal((await store.status(task.id)).status, "superseded");
  await assert.rejects(store.claim(deviceID, task.id), { statusCode: 409 });
  await store.register({ ...register, allowAI: false });
  assert.equal((await store.status(next.id)).status, "pending");
  await assert.rejects(store.mutate({ kind: "update", alarmID: task.alarmID, expectedRevision: 1, config: morning }, manual), { statusCode: 409 });
  const once = await store.mutate({ kind: "create", config: { ...morning, repeat: "once", fireAt: "2026-03-01T08:00:00-05:00" } }, manual);
  current += 7_200_000;
  assert.equal((await store.status(once.id)).status, "expired");
  await assert.rejects(store.claim(deviceID, once.id), { statusCode: 409 });
  await store.claim(deviceID, next.id);
  await store.receipt(deviceID, next.id, { status: "applied", ringtone: "voice" });
  const removal = await store.mutate({ kind: "delete", alarmID: task.alarmID, expectedRevision: 2 }, manual);
  await store.claim(deviceID, removal.id);
  await store.receipt(deviceID, removal.id, { status: "applied" });
  assert.ok(!(await store.get()).alarms.some(row => row.id === task.alarmID));
});

test("one-time local dates use device timezone, including DST gaps and folds", async t => {
  const [store] = await fixture(t, () => Date.parse("2026-03-01T12:00:00Z"));
  await store.register(register);
  const create = fields => store.mutate({ kind: "create", config: { ...morning, repeat: "once", ...fields } }, { source: "ai" });
  assert.equal((await create({ fireLocal: "2026-03-09T08:00" })).config.fireAt, "2026-03-09T12:00:00.000Z");
  await assert.rejects(create({ fireLocal: "2026-03-08T02:30" }), /不存在/);
  await assert.rejects(create({ fireLocal: "2026-11-01T01:30" }), /出现两次/);
  assert.equal((await create({ fireAt: "2026-11-01T01:30:00-05:00" })).config.fireAt, "2026-11-01T06:30:00.000Z");
  await assert.rejects(create({ fireAt: "2026-03-09T08:00" }), /偏移/);
});
