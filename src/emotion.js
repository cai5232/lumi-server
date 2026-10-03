import { randomUUID } from "node:crypto";

export const EMOTION_DRIVES = {
  attachment: { baseline: 0.40, decay: 0.005, label: "想念" },
  tenderness: { baseline: 0.30, decay: 0.004, label: "心软" },
  heartache: { baseline: 0.35, decay: 0.004, label: "心疼" },
  curiosity: { baseline: 0.25, decay: 0.006, label: "好奇" },
  mischief: { baseline: 0.20, decay: 0.007, label: "促狭" },
  restless: { baseline: 0.15, decay: 0.008, label: "躁动" },
  regret: { baseline: 0.10, decay: 0.006, label: "后悔" },
  desire: { baseline: 0.25, decay: 0.006, label: "欲望" },
  gloom: { baseline: 0.10, decay: 0.003, label: "低落" },
  jealousy: { baseline: 0.10, decay: 0.008, label: "吃醋" }
};

export const EMOTION_TICK_MS = 10 * 60_000;
export const EMOTION_REFLECTION_MS = 20 * 60_000;
export const EMOTION_REFLECTION_THRESHOLD = 0.65;
export const EMOTION_PUSH_THRESHOLD = 0.50;
export const EMOTION_PUSH_INTERVAL_MS = 2 * 60 * 60_000;
export const EMOTION_ATTACHMENT_PUSH_INTERVAL_MS = 45 * 60_000;
export const EMOTION_OFFLINE_DELAY_TICKS = 6;
const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export function createEmotionState(now = Date.now()) {
  return {
    drives: Object.fromEntries(Object.entries(EMOTION_DRIVES).map(([key, config]) => [key, config.baseline])),
    lastTickAt: now,
    lastReflectionAt: now,
    lastAttachmentPushAt: 0,
    lastDrivePushAt: {},
    pendingAttachmentPushes: 0,
    offlineTicks: 0,
    arc: [],
    regrets: [],
    memory: { short: "", long: "" },
    lastOnlineAt: now
  };
}

export function ensureEmotion(thread, now = Date.now()) {
  if (!thread.emotion || typeof thread.emotion !== "object") thread.emotion = createEmotionState(now);
  const state = thread.emotion;
  const fresh = createEmotionState(now);
  state.drives = { ...fresh.drives, ...(state.drives || {}) };
  for (const [key, value] of Object.entries(state.drives)) state.drives[key] = clamp(value);
  state.lastTickAt = Number(state.lastTickAt) || now;
  state.lastReflectionAt = Number(state.lastReflectionAt) || now;
  state.lastAttachmentPushAt = Number(state.lastAttachmentPushAt) || 0;
  state.lastDrivePushAt = state.lastDrivePushAt && typeof state.lastDrivePushAt === "object" ? state.lastDrivePushAt : {};
  state.pendingAttachmentPushes = Math.max(0, Math.min(5, Number(state.pendingAttachmentPushes) || 0));
  state.offlineTicks = Math.max(0, Number(state.offlineTicks) || 0);
  state.arc = Array.isArray(state.arc) ? state.arc : [];
  state.regrets = Array.isArray(state.regrets) ? state.regrets : [];
  state.memory = state.memory && typeof state.memory === "object" ? state.memory : { short: "", long: "" };
  state.memory.short = String(state.memory.short || "").slice(0, 2000);
  state.memory.long = String(state.memory.long || "").slice(0, 20_000);
  return state;
}

export function topEmotions(state, limit = 3) {
  return Object.entries(state.drives)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([drive, value]) => ({ drive, value, label: EMOTION_DRIVES[drive]?.label || drive }));
}

export function topEmotion(state) {
  return topEmotions(state, 1)[0] || { drive: "attachment", value: 0.4, label: "想念" };
}

export function tickEmotion(state, now = Date.now(), quietAt = () => false) {
  const elapsed = Math.max(0, now - Number(state.lastTickAt || now));
  const ticks = Math.min(144, Math.floor(elapsed / EMOTION_TICK_MS));
  if (!ticks) return 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    const tickAt = Number(state.lastTickAt || now) + (tick + 1) * EMOTION_TICK_MS;
    for (const [drive, config] of Object.entries(EMOTION_DRIVES)) {
      if (drive === "attachment") continue;
      const value = state.drives[drive];
      state.drives[drive] = clamp(value - (value - config.baseline) * config.decay * 10);
    }
    state.offlineTicks += 1;
    if (state.offlineTicks >= EMOTION_OFFLINE_DELAY_TICKS) {
      state.drives.attachment = clamp(state.drives.attachment + (quietAt(tickAt) ? 0.01 : 0.05));
    } else {
      const config = EMOTION_DRIVES.attachment;
      state.drives.attachment = clamp(state.drives.attachment - (state.drives.attachment - config.baseline) * config.decay * 10);
    }
  }
  state.lastTickAt += ticks * EMOTION_TICK_MS;
  return ticks;
}

export function markEmotionOnline(state, now = Date.now()) {
  // Coming online ends offline accumulation, but does not erase the feeling
  // that accumulated while the user was away.
  state.offlineTicks = 0;
  state.lastOnlineAt = now;
}

export function applyEmotionDelta(state, update, now = Date.now()) {
  if (!update || typeof update !== "object") return false;
  const changes = update.changes && typeof update.changes === "object"
    ? Object.entries(update.changes).map(([drive, delta]) => ({ drive, delta }))
    : [update];
  let changed = false;
  for (const item of changes) {
    const drive = String(item.drive || "");
    const delta = Number(item.delta);
    if (!Object.hasOwn(EMOTION_DRIVES, drive) || !Number.isFinite(delta)) continue;
    const bounded = Math.max(-0.2, Math.min(0.2, delta));
    state.drives[drive] = clamp(state.drives[drive] + bounded);
    changed = changed || bounded !== 0;
    if (drive === "regret" && bounded > 0 && typeof item.reason === "string" && item.reason.trim()) {
      state.regrets.push({ time: new Date(now).toISOString(), text: item.reason.trim().slice(0, 500) });
      state.regrets = state.regrets.slice(-200);
    }
  }
  return changed;
}
export function addEmotionArc(state, { drive, text, type = "murmur", now = Date.now(), value } = {}) {
  if (!Object.hasOwn(EMOTION_DRIVES, drive) || typeof text !== "string" || !text.trim()) return null;
  const entry = {
    id: randomUUID(), time: new Date(now).toISOString(), drive,
    zh: EMOTION_DRIVES[drive].label,
    val: Number.isFinite(Number(value)) ? clamp(value) : state.drives[drive],
    text: text.trim().slice(0, 2000), type
  };
  state.arc.push(entry);
  state.arc = state.arc.slice(-500);
  return entry;
}

export function emotionContext(state) {
  const current = topEmotion(state);
  const strongest = topEmotions(state, 3);
  const drives = Object.entries(EMOTION_DRIVES).map(([key, config]) => `${key}(${config.label})=${state.drives[key].toFixed(2)}`).join("; ");
  const shortMemory = String(state.memory?.short || "").trim();
  const longMemory = String(state.memory?.long || "").trim();
  const recentArc = state.arc.slice(-3).map((item) => `${item.zh}：${item.text}`).join("\n");
  const strongestText = strongest.map((item) => `${item.drive}（${item.label}，${item.value.toFixed(2)}）`).join("、");
  return `<emotion_state source="persistent_drive_state">当前最强的三种情绪：${strongestText}；全部驱动力：${drives}。这些数值和标签是内部状态，不要照搬给用户，也不要套用固定句子。请让这三种情绪共同影响你的语气、关注点、距离感和是否表达；只有在符合当前关系与上下文时，才用你自己的方式自然表现出来。${shortMemory ? `\n短期情绪记忆：${shortMemory}` : ""}${longMemory ? `\n长期情绪记忆：${longMemory}` : ""}${recentArc ? `\n近期内心独白：\n${recentArc}` : ""}</emotion_state>`;
}
