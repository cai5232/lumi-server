const minute = 60_000;
const sceneDefaults = {
  outing: [30, 480],
  work: [60, 600],
  repeat: [10, 180],
  custom: [45, 360]
};

const minutesInRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const clean = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const appKey = name => clean(name, 80).normalize("NFKC").toLowerCase();
const sceneID = value => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(value);

export function activeWakeScenes(state, now) {
  return (Array.isArray(state?.scenes) ? state.scenes : []).filter(scene => scene.expiresAt > now);
}

export function applyWakeSceneActions(state, actions, now, sourceMessageID = null) {
  if (!Array.isArray(actions) || !actions.length) return state;
  let scenes = activeWakeScenes(state, now);
  let snoozedUntil = state?.snoozedUntil ?? null;
  for (const action of actions.slice(0, 8)) {
    if (action?.op === "snooze" && minutesInRange(action.minutes, 5, 240)) {
      snoozedUntil = now + action.minutes * minute;
      continue;
    }
    if (!sceneID(action?.id)) continue;
    if (action.op === "end") {
      scenes = scenes.filter(scene => scene.id !== action.id);
      continue;
    }
    if (action.op !== "upsert") continue;
    const existing = scenes.find(scene => scene.id === action.id);
    if (!existing && scenes.length >= 12) continue;
    const kind = action.kind ?? existing?.kind ?? "custom";
    if (!Object.hasOwn(sceneDefaults, kind)) continue;
    const [defaultCadence, defaultDuration] = sceneDefaults[kind];
    const cadence = action.cadenceMin === undefined ? (existing ? existing.cadenceMin : defaultCadence) : action.cadenceMin;
    if (cadence !== null && !minutesInRange(cadence, 5, 240)) continue;
    if (action.durationMin !== undefined && !minutesInRange(action.durationMin, 10, 1_440)) continue;
    const expiresAt = action.durationMin !== undefined
      ? now + action.durationMin * minute : (existing?.expiresAt ?? now + defaultDuration * minute);
    let appOpen = existing?.appOpen ?? null;
    if (action.appOpen !== undefined) {
      const app = clean(action.appOpen, 80);
      if (action.appOpen !== null && !app) continue;
      if (action.appOpen === null) appOpen = null;
      else if (appKey(appOpen?.app) !== appKey(app)) appOpen = { app, since: now };
    }
    if (cadence === null && !appOpen) continue;
    let note = existing?.note ?? null;
    if (action.note !== undefined) {
      const text = clean(action.note, 300);
      note = text ? { text, remaining: 3 } : null;
    }
    const scene = {
      id: action.id, kind,
      facts: action.facts === undefined ? (existing?.facts ?? "") : clean(action.facts, 400),
      cadenceMin: cadence,
      nextAt: cadence === null ? null
        : (!existing || action.cadenceMin !== undefined ? now + cadence * minute : existing.nextAt),
      expiresAt, appOpen, note,
      sourceMessageIDs: [...new Set([...(existing?.sourceMessageIDs || []), ...(sourceMessageID ? [sourceMessageID] : [])])]
    };
    scenes = [...scenes.filter(item => item.id !== scene.id), scene];
  }
  return { ...state, scenes, snoozedUntil };
}

export function dueWakeScenes(state, appEvents, now) {
  if (state?.snoozedUntil > now || state?.retryAt > now) return [];
  return activeWakeScenes(state, now).flatMap(scene => {
    const timed = Number.isFinite(scene.nextAt) && scene.nextAt <= now;
    const app = scene.appOpen && appEvents.find(event => {
      const at = Date.parse(event.openedAt || event.firstSeenAt || event.createdAt);
      return appKey(event.app) === appKey(scene.appOpen.app) && at > scene.appOpen.since && at <= now;
    });
    return timed || app ? [{ scene, timed, app: app?.app ?? null }] : [];
  });
}

export function completeWakeScenes(state, due, now) {
  if (!due.length) return state;
  const completed = new Map(due.map(item => [item.scene.id, item]));
  const scenes = activeWakeScenes(state, now).flatMap(scene => {
    const wake = completed.get(scene.id);
    if (!wake) return [scene];
    const appOpen = wake.app ? null : scene.appOpen;
    if (scene.cadenceMin === null && !appOpen) return [];
    return [{
      ...scene, appOpen,
      nextAt: wake.timed ? now + scene.cadenceMin * minute : scene.nextAt,
      note: scene.note?.remaining > 1 ? { ...scene.note, remaining: scene.note.remaining - 1 } : null
    }];
  });
  return { ...state, scenes, retryAt: null };
}

export function extractWakeSceneActions(reply) {
  let actions = [];
  const blocks = /```[\s\S]*?(?:```|$)|<(thinking|think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<wake_scene_actions\b[^>]*>([\s\S]*?)(<\/wake_scene_actions\s*>|$)/gi;
  const content = reply.replace(blocks, (block, privateTag, raw, closed) => {
    if (privateTag || block.startsWith("```")) return block;
    if (!closed || raw.length > 8_192) return "";
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) actions = [...actions, ...parsed.slice(0, 8)].slice(0, 8);
    } catch {}
    return "";
  }).trim();
  return { content, actions };
}

export function wakeSceneContext(state, due, now) {
  const scenes = activeWakeScenes(state, now).map(({ id, kind, facts, cadenceMin, nextAt, expiresAt, appOpen }) =>
    ({ id, kind, facts, cadenceMin, nextAt, expiresAt, appOpen: appOpen?.app ?? null }));
  const triggers = due.map(({ scene, timed, app }) => ({ id: scene.id, timed, app, note: scene.note?.text }));
  const report = JSON.stringify({ scenes, triggers }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `<wake_scene_context>${report}</wake_scene_context>`;
}
