// A read-only overlay. Never pass display values to persistence, decay or event updates.
export const CIRCADIAN_CAP = 0.08;
export const CIRCADIAN_PHASES = Object.freeze(Object.fromEntries(Object.entries({
  attachment: [22, 0.5], curiosity: [10, 1], nostalgia: [23, 0.9],
  responsibility: [14, 0.7], social: [19, 0.8], fatigue: [3, 1],
  desire: [23, 0.7], stress: [16, 0]
}).map(([key, [peak, amp]]) => [key, Object.freeze({ peak, amp })])));

export function circadianOptions(env = process.env) {
  const candidate = env.LUMI_CIRCADIAN_TIME_ZONE || env.LUMI_USER_TIME_ZONE || 'Asia/Shanghai';
  let timeZone = candidate;
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); }
  catch { timeZone = 'Asia/Shanghai'; }
  return { enabled: env.LUMI_CIRCADIAN_ENABLED !== 'false', timeZone };
}

export function circadianOffset(key, hour) {
  const config = CIRCADIAN_PHASES[key];
  if (!config || !config.amp) return 0;
  return CIRCADIAN_CAP * config.amp * Math.cos(2 * Math.PI * (hour - config.peak) / 24);
}

export function circadianSnapshot(base, now = Date.now(), options = circadianOptions()) {
  const { enabled = true, timeZone = 'Asia/Shanghai' } = options;
  const instant = new Date(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(instant);
  const part = (name) => Number(parts.find((item) => item.type === name).value);
  const hour = part('hour') + part('minute') / 60 + (part('second') + instant.getUTCMilliseconds() / 1000) / 3600;
  const offsets = {};
  const display = {};
  for (const [key, item] of Object.entries(base)) {
    const wrapped = item !== null && typeof item === 'object';
    const value = wrapped ? item.v : item;
    const offset = enabled ? circadianOffset(key, hour) : 0;
    offsets[key] = offset;
    // Preserve exact numbers and metadata when disabled (including JSON serialization).
    const adjusted = !enabled || offset === 0 ? value : Math.max(0, Math.min(1, value + offset));
    display[key] = wrapped ? { ...item, v: adjusted } : adjusted;
  }
  const phase = hour < 5 ? 'night' : hour < 8 ? 'dawn' : hour < 12 ? 'morning'
    : hour < 18 ? 'afternoon' : hour < 22 ? 'evening' : 'night';
  return { drive_display: display, circadian: { offsets, phase, now_hour: hour, cap: CIRCADIAN_CAP, enabled, time_zone: timeZone } };
}

// Add fields to a local or Murmur response without changing any upstream fields.
export function withCircadianState(payload, now = Date.now(), options = circadianOptions()) {
  if (!payload || typeof payload !== 'object' || !payload.drives || typeof payload.drives !== 'object') return payload;
  return { ...payload, ...circadianSnapshot(payload.drives, now, options) };
}
