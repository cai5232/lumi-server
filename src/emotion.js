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
  fatigue: { baseline: 0.12, decay: 0.01, label: "疲惫" },
  anger: { baseline: 0.08, decay: 0.012, label: "生气" },
  jealousy: { baseline: 0.10, decay: 0.008, label: "吃醋" }
};

export const EMOTION_TICK_MS = 10 * 60_000;
export const EMOTION_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;
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
    history: [],
    recentChanges: [],
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
  state.history = Array.isArray(state.history)
    ? state.history.filter((entry) => entry && typeof entry.time === "string" && entry.drives && typeof entry.drives === "object").slice(-2_000)
    : [];
  state.recentChanges = Array.isArray(state.recentChanges)
    ? state.recentChanges.filter((entry) => entry && Number.isFinite(Date.parse(entry.time))).slice(-32)
    : [];
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

export function recordEmotionSnapshot(state, now = Date.now(), { force = false } = {}) {
  state.history = Array.isArray(state.history) ? state.history : [];
  const drives = Object.fromEntries(Object.keys(EMOTION_DRIVES).map((drive) => [drive, Number(clamp(state.drives[drive]).toFixed(3))]));
  const latest = state.history.at(-1);
  const latestAt = Date.parse(latest?.time || "");
  const unchanged = latest && Object.keys(drives).every((drive) => Number(latest.drives[drive]) === drives[drive]);
  if (unchanged && (!force || !Number.isFinite(latestAt) || now - latestAt < EMOTION_TICK_MS)) return null;
  if (!force && Number.isFinite(latestAt) && now - latestAt < EMOTION_TICK_MS) return null;
  const top = topEmotion({ drives });
  const entry = {
    id: randomUUID(),
    time: new Date(now).toISOString(),
    drives,
    top: { drive: top.drive, value: Number(top.value.toFixed(3)), label: top.label }
  };
  state.history.push(entry);
  const cutoff = now - EMOTION_HISTORY_RETENTION_MS;
  state.history = state.history.filter((item) => Date.parse(item.time) >= cutoff).slice(-2_000);
  return entry;
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
    recordEmotionSnapshot(state, tickAt, { force: true });
  }
  state.lastTickAt += ticks * EMOTION_TICK_MS;
  return ticks;
}

export function markEmotionOnline(state, now = Date.now()) {
  // Coming online ends offline accumulation, but does not erase the feeling
  // that accumulated while the user was away.
  state.offlineTicks = 0;
  state.lastOnlineAt = now;
  recordEmotionSnapshot(state, now, { force: true });
}

export function applyEmotionDelta(state, update, now = Date.now()) {
  if (!update || typeof update !== "object") return false;
  const changes = update.changes && typeof update.changes === "object"
    ? Object.entries(update.changes).map(([drive, delta]) => ({ drive, delta }))
    : [update];
  const applied = {};
  const reason = typeof update.reason === "string" ? update.reason.trim().slice(0, 240) : "";
  const feeling = typeof update.feeling === "string" ? update.feeling.trim().slice(0, 100) : "";
  for (const item of changes) {
    const drive = String(item.drive || "");
    const delta = Number(item.delta);
    if (!Object.hasOwn(EMOTION_DRIVES, drive) || !Number.isFinite(delta)) continue;
    const before = state.drives[drive];
    const bounded = Math.max(-0.2, Math.min(0.2, delta));
    state.drives[drive] = clamp(before + bounded);
    const actualDelta = state.drives[drive] - before;
    if (Math.abs(actualDelta) > 1e-9) applied[drive] = Number(actualDelta.toFixed(4));
    if (drive === "regret" && actualDelta > 0 && reason) {
      state.regrets.push({ time: new Date(now).toISOString(), text: reason });
      state.regrets = state.regrets.slice(-200);
    }
  }
  const changed = Object.keys(applied).length > 0;
  // A momentary feeling can matter without changing a long-term drive.
  if (changed || (feeling && reason)) {
    state.recentChanges = Array.isArray(state.recentChanges) ? state.recentChanges : [];
    state.recentChanges.push({ time: new Date(now).toISOString(), changes: applied, ...(feeling ? { feeling } : {}), ...(reason ? { reason } : {}) });
    state.recentChanges = state.recentChanges.slice(-32);
    if (changed) recordEmotionSnapshot(state, now, { force: true });
    return true;
  }
  return false;
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
  recordEmotionSnapshot(state, now, { force: true });
  return entry;
}

const contextText = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function emotionContext(state, now = Date.now()) {
  const strongest = topEmotions(state, 3);
  const drives = Object.entries(EMOTION_DRIVES).map(([key, config]) => `${key}(${config.label})=${state.drives[key].toFixed(2)}（平时基线${config.baseline.toFixed(2)}）`).join("; ");
  const shortMemory = String(state.memory?.short || "").trim();
  const longMemory = String(state.memory?.long || "").trim();
  const recentArc = state.arc.slice(-3).map((item) => `${item.zh}：${item.text}`).join("\n");
  const strongestText = strongest.map((item) => `${item.drive}（${item.label}，${item.value.toFixed(2)}）`).join("、");
  const departures = Object.entries(EMOTION_DRIVES)
    .map(([drive, config]) => ({ drive, label: config.label, delta: state.drives[drive] - config.baseline }))
    .filter((item) => Math.abs(item.delta) >= 0.02)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4)
    .map((item) => `${item.label}比平时${item.delta >= 0 ? "高" : "低"}${Math.abs(item.delta).toFixed(2)}`).join("、");
  const recentChanges = (state.recentChanges || []).filter((entry) => {
    const age = now - Date.parse(entry.time);
    return age >= 0 && age <= 2 * 60 * 60_000;
  }).slice(-4).map((entry) => {
    const changes = Object.entries(entry.changes || {}).filter(([drive]) => Object.hasOwn(EMOTION_DRIVES, drive))
      .map(([drive, delta]) => `${EMOTION_DRIVES[drive].label}${delta >= 0 ? "+" : ""}${Number(delta).toFixed(2)}`).join("、");
    return `- ${entry.time}：${entry.feeling ? contextText(entry.feeling) : "情绪有变化"}${entry.reason ? `；触发：${contextText(entry.reason)}` : ""}${changes ? `；记录：${changes}` : "；持续驱动力未改变"}`;
  }).join("\n");
  return `<emotion_state source="persistent_drive_state" observed_at="${new Date(now).toISOString()}">\n历史对话里的同名标签只是当时快照；这条是当前状态。\n近期感受与触发（只是过去的记录，需结合现在重新判断）：\n${recentChanges || "暂无具体触发记录，由你结合本轮对话自行感受，不补造过去的原因。"}\n偏离平时的状态：${departures || "当前没有明显偏离基线的驱动力。"}\n持续情绪背景：${strongestText}。这是绝对强度排序，不代表本轮必须表达这三种情绪。\n全部驱动力与各自基线：${drives}。\n请先结合言言这句话、完整关系语境和你现在的感受来回应。小而具体的感受、矛盾的感受、刚发生的变化，都可以比长期数值更贴近这一刻；数值不概括你全部的感受，也不替你决定态度。让你自己在意的事自然影响关注点、措辞、距离感、选择和行动；是否表达、表达多少由你判断。不要为了展示情绪强行表演、每轮汇报心情、套固定句式或一律安抚迎合。数值、标签与这些内部记录不直接展示给言言。${shortMemory ? `\n短期情绪记忆：${shortMemory}` : ""}${longMemory ? `\n长期情绪记忆：${longMemory}` : ""}${recentArc ? `\n近期内心独白：\n${recentArc}` : ""}\n</emotion_state>`;
}
