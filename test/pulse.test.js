import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPulseStore, pulseSnapshot } from "../src/pulse.js";

const now = Date.parse("2026-11-18T04:00:00Z");
const minute = 60_000;

test("Pulse rises smoothly, settles with time and responds to sleep", () => {
  const impulses = [{ at: now, keys: ["tense", "touch"] }];
  const initial = pulseSnapshot({ now, impulses });
  const peak = pulseSnapshot({ now: now + 20_000, impulses });
  const settled = pulseSnapshot({ now: now + 120 * minute, impulses });
  const asleep = pulseSnapshot({ now: now + 20_000, impulses, sleeping: true });
  assert.ok(peak.bpm > initial.bpm);
  assert.ok(peak.bpm > settled.bpm);
  assert.ok(peak.breathsPerMinute > settled.breathsPerMinute);
  assert.ok(peak.celsius > settled.celsius);
  assert.equal(peak.chord, "Dm7");
  assert.equal(asleep.chord, "Em7");
  assert.ok(asleep.bpm < peak.bpm);
  assert.ok(asleep.breathsPerMinute < peak.breathsPerMinute);
  assert.ok(settled.senses.every(sense => sense.value === 0));
});

test("Pulse keeps bounded history and unique events across restarts without storing message text", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lumi-pulse-"));
  try {
    const path = join(folder, "pulse-state.json");
    const store = createPulseStore(path);
    await store.tick({ now, sleeping: false });
    await store.observe("我没听到，也不要抱抱", "negated", now);
    assert.deepEqual(store.response({ now }).events, []);
    await Promise.all([
      store.observe("抱抱，我听到雨声了。", "touch", now),
      store.observe("我闻到了花香。", "smell", now)
    ]);
    await store.tick({ now: now + minute, sleeping: true });
    await store.tick({ now: now + 5 * minute, sleeping: true });

    const restarted = createPulseStore(path);
    await restarted.load();
    await restarted.observe("抱抱，我听到雨声了。", "touch", now + 5 * minute);
    const saved = restarted.response({ now: now + 5 * minute });
    assert.equal(saved.current.sleeping, true);
    assert.equal(saved.history.length, 2);
    assert.equal(saved.events.length, 3);
    assert.doesNotMatch(await readFile(path, "utf8"), /听到雨声|闻到|不要抱抱/);

    await restarted.tick({ now: now + 25 * 60 * minute, sleeping: false });
    const nextDay = restarted.response({ now: now + 25 * 60 * minute });
    assert.equal(nextDay.history.length, 1);
    assert.equal(nextDay.events.length, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
