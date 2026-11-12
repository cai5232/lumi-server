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

export function applyWakeSceneActions(state, actions, now) {
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
      expiresAt, appOpen, note
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
  const blocks = /<(thinking|think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<wake_scene_actions\b[^>]*>([\s\S]*?)(<\/wake_scene_actions\s*>|$)/gi;
  const content = reply.replace(blocks, (block, privateTag, raw, closed) => {
    if (privateTag) return block;
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
  return `<wake_scene_context>
${report}
上面是已保存的数据。根据当前对话中确实发生的事，或用户明确约定的后续安排，建立或调整需要持续跟进的情境。用户说已结束或不想再跟进时，结束对应情境。普通闲聊无需建立情境。被唤醒时先看 triggers，按记录的事实和字条接续，不要虚构设备事件。
确需改动时，在回复末尾附加一个隐藏块 <wake_scene_actions>[{"op":"upsert","id":"outing","kind":"outing","facts":"实际发生的事","cadenceMin":30,"durationMin":120,"note":"下次要记得问的事"}]</wake_scene_actions>。id 用简短英文、数字或下划线；重复使用同一 id 更新。kind 可为 outing、work、repeat、custom。cadenceMin 5–240，durationMin 10–1440；更新时只写要改的字段。
等待指定 App 的打开记录时设 appOpen 为该 App 名称，只等事件可同时设 cadenceMin:null。只有快捷指令实际报告 App 打开才能触发。appOpen:null 取消条件，note:null 清除字条。结束用 {"op":"end","id":"outing"}，暂缓普通唤醒用 {"op":"snooze","minutes":30}（5–240 分钟）。明确钟点的提醒走原有约定闹钟。
</wake_scene_context>`;
}
