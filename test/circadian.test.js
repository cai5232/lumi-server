import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CIRCADIAN_CAP, CIRCADIAN_PHASES, circadianOffset, circadianOptions, circadianSnapshot, withCircadianState } from '../src/circadian.js';
import { createEmotionState, emotionContext, tickEmotion, EMOTION_TICK_MS } from '../src/emotion.js';
const utc = { enabled: true, timeZone: 'UTC' };
const at = (hour) => Date.UTC(2026, 5, 17, hour);

test('every configured curve is bounded, peaks/troughs are exact, and midnight closes continuously', () => {
  for (const [key, { peak, amp }] of Object.entries(CIRCADIAN_PHASES)) {
    assert.ok(Math.abs(circadianOffset(key, peak) - CIRCADIAN_CAP * amp) < 1e-12);
    assert.ok(Math.abs(circadianOffset(key, peak + 12) + CIRCADIAN_CAP * amp) < 1e-12);
    for (let h = 0; h <= 24; h += .01) assert.ok(Math.abs(circadianOffset(key, h)) <= CIRCADIAN_CAP * amp + 1e-12);
    assert.ok(Math.abs(circadianOffset(key, 0) - circadianOffset(key, 24)) < 1e-12);
    assert.ok(Math.abs(circadianOffset(key, 24 - 1e-6) - circadianOffset(key, 1e-6)) < 1e-6);
  }
  assert.equal(circadianOffset('stress', 16), 0);
  assert.equal(circadianOffset('anger', 16), 0);
});

test('snapshots clamp only display and never accumulate into base, history or later decay', () => {
  const state = createEmotionState(at(9));
  state.drives.curiosity = .99;
  state.drives.fatigue = .01;
  const original = JSON.stringify(state);
  const snapshot = circadianSnapshot(state.drives, at(10), utc);
  assert.equal(snapshot.drive_display.curiosity, 1);
  assert.equal(snapshot.drive_display.fatigue, 0);
  for (let i = 0; i < 100; i++) {
    circadianSnapshot(state.drives, at(10), utc);
    emotionContext(state, at(10));
  }
  assert.equal(JSON.stringify(state), original);
  const control = JSON.parse(original);
  tickEmotion(state, at(9) + EMOTION_TICK_MS);
  tickEmotion(control, at(9) + EMOTION_TICK_MS);
  const withoutIDs = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === 'id' ? undefined : item));
  assert.deepEqual(withoutIDs(state), withoutIDs(control));
});

test('disabled numeric and Murmur snapshots exactly preserve base values and all original fields', () => {
  for (const drives of [{ curiosity: .123456789, fatigue: .9 }, { curiosity: { v: .123456789, z: '好奇', b: .25 }, stress: { v: .5, z: '压力' } }]) {
    const payload = { drives, top: { drive: 'fatigue', value: .9 }, offlineTicks: 7, extra: ['untouched'] };
    const before = JSON.stringify(payload);
    const result = withCircadianState(payload, at(10), { ...utc, enabled: false });
    assert.equal(JSON.stringify(result.drive_display), JSON.stringify(drives));
    assert.ok(Object.values(result.circadian.offsets).every(v => v === 0));
    assert.equal(result.circadian.enabled, false);
    const { drive_display, circadian, ...legacy } = result;
    assert.equal(JSON.stringify(legacy), before);
    assert.equal(JSON.stringify(payload), before);
  }
  const error = { error: 'upstream_failed' };
  assert.equal(withCircadianState(error), error);
});

test('wrapped response applies the same curve and preserves labels and base markers', () => {
  const base = { curiosity: { v: .25, z: '好奇', b: .25 }, heartache: { v: .35, z: '心疼' } };
  const result = circadianSnapshot(base, at(10), utc);
  assert.equal(result.drive_display.curiosity.v, .25 + .08);
  assert.equal(result.drive_display.curiosity.b, .25);
  assert.equal(result.drive_display.curiosity.z, '好奇');
  assert.deepEqual(result.drive_display.heartache, base.heartache);
  assert.equal(result.circadian.phase, 'morning');
});

test('clock uses configured local fractional hours, handles DST and rejects invalid environment zones safely', () => {
  const base = { curiosity: .25 };
  const now = Date.UTC(2026, 5, 17, 2, 30, 15, 500);
  const shanghai = circadianSnapshot(base, now, { ...utc, timeZone: 'Asia/Shanghai' });
  assert.ok(Math.abs(shanghai.circadian.now_hour - (10.5 + 15.5 / 3600)) < 1e-12);
  const zone = { ...utc, timeZone: 'America/New_York' };
  assert.equal(circadianSnapshot(base, Date.UTC(2026, 0, 17, 15), zone).circadian.now_hour, 10);
  assert.equal(circadianSnapshot(base, Date.UTC(2026, 5, 17, 14), zone).circadian.now_hour, 10);
  assert.deepEqual(circadianOptions({ LUMI_CIRCADIAN_ENABLED: 'false', LUMI_USER_TIME_ZONE: 'UTC' }), { enabled: false, timeZone: 'UTC' });
  assert.equal(circadianOptions({ LUMI_CIRCADIAN_TIME_ZONE: 'invalid' }).timeZone, 'Asia/Shanghai');
});

test('model receives a private read-only clock cue and disabling restores the original prompt', () => {
  const previous = process.env.LUMI_CIRCADIAN_ENABLED;
  const state = createEmotionState(at(10));
  try {
    delete process.env.LUMI_CIRCADIAN_ENABLED;
    assert.match(emotionContext(state, at(10)), /此刻生物钟/);
    process.env.LUMI_CIRCADIAN_ENABLED = 'false';
    assert.doesNotMatch(emotionContext(state, at(10)), /此刻生物钟/);
  } finally {
    if (previous === undefined) delete process.env.LUMI_CIRCADIAN_ENABLED;
    else process.env.LUMI_CIRCADIAN_ENABLED = previous;
  }
});
