import { createHash } from "node:crypto";

const TERMINAL = new Set(["completed", "cancelled", "superseded"]);
const LIVE = new Set(["active", "completion_unknown"]);
const MAX_EVENTS = 12;

function localDateTime(ms, timeZone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date(ms)).replace(/\//g, "-");
}

function boundedText(value, max = 280) {
  return String(value || "").replace(/[\r\n\u0000-\u001f]+/g, " ").trim().slice(0, max);
}

function validTime(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function normalizeId(value, fact) {
  const id = boundedText(value, 80).replace(/[^\p{L}\p{N}_.:-]+/gu, "-").replace(/^-+|-+$/g, "");
  return id || createHash("sha256").update(fact).digest("hex").slice(0, 16);
}

function normalizeEvent(event, now, priorById, sourceAt) {
  if (!event || typeof event !== "object" || !LIVE.has(event.status)) return null;
  const fact = boundedText(event.fact);
  if (!fact) return null;
  const id = normalizeId(event.id, fact);
  const previous = priorById.get(id);
  const eventSourceAt = validTime(event.sourceAt) ? new Date(event.sourceAt).toISOString() : "";
  const wasUnchanged = previous && previous.fact === fact && previous.sourceAt === eventSourceAt;
  const isCurrentEvidence = eventSourceAt &&
    Math.abs(Date.parse(eventSourceAt) - Date.parse(sourceAt)) <= 2 * 60_000;
  if (!wasUnchanged && !isCurrentEvidence) return null;
  const eventAt = validTime(event.eventAt) ? new Date(event.eventAt).toISOString() : null;
  const expiresAt = validTime(event.expiresAt) ? new Date(event.expiresAt).toISOString() : null;
  if (expiresAt && Date.parse(expiresAt) <= now) return null;

  let status = event.status;
  if (status === "active" && eventAt && Date.parse(eventAt) < now) status = "completion_unknown";
  if (status === "completion_unknown" && eventAt && now - Date.parse(eventAt) > 7 * 86_400_000) return null;

  return {
    id, fact, status,
    sourceAt: wasUnchanged ? previous.sourceAt : eventSourceAt,
    eventAt,
    expiresAt
  };
}

/**
 * Build request-local time-gap and live-event context. The transcript remains
 * the authority; capsules are changed only by a validated model update grounded
 * in the latest user message.
 */
export function buildLiveAttentionContext({ messages = [], events = [], now = Date.now(), timeZone = "Asia/Shanghai", allowUpdates = true } = {}) {
  const lastMessage = [...messages].reverse().find(message =>
    (message?.role === "user" || message?.role === "assistant") && validTime(message?.createdAt));
  const lastAt = lastMessage ? Date.parse(lastMessage.createdAt) : NaN;
  const elapsedMs = Number.isFinite(lastAt) ? Math.max(0, now - lastAt) : 0;
  const gap = elapsedMs >= 15 * 60_000
    ? `<dialogue_gap minutes="${Math.floor(elapsedMs / 60_000)}">距上次聊天约 ${Math.floor(elapsedMs / 60_000)} 分钟；当前北京时间 ${localDateTime(now, timeZone)}。这是实际经过的时间，不要把上一句当成刚刚发生。</dialogue_gap>`
    : "";

  const active = (Array.isArray(events) ? events : [])
    .filter(event => event && LIVE.has(event.status) && (!event.expiresAt || !validTime(event.expiresAt) || Date.parse(event.expiresAt) > now))
    .map(event => event.status === "active" && validTime(event.eventAt) && Date.parse(event.eventAt) < now
      ? { ...event, status: "completion_unknown" }
      : event)
    .filter(event => !(event.status === "completion_unknown" && validTime(event.eventAt) && now - Date.parse(event.eventAt) > 7 * 86_400_000))
    .slice(-MAX_EVENTS);
  const lines = active.map(event => {
    const when = event.eventAt ? `；事项时间 ${event.eventAt}` : "";
    const state = event.status === "completion_unknown"
      ? "已过计划时间，是否完成未知；不得视为仍在进行，也不得自动顺延"
      : "仍有效";
    return `- [${event.id}] ${event.fact}（${state}${when}；来源 ${event.sourceAt}）`;
  });
  const sourceAt = new Date(now).toISOString();
  const updateRule = allowUpdates
    ? `本轮若用户明确确认了事项发生、计划、纠正、完成或取消，在最终回复末尾附加隐藏标签 <live_attention_update>{"upsert":[{"id":"稳定事项ID","fact":"简短、具体的事实或计划","status":"active或completion_unknown","sourceAt":"${sourceAt}","eventAt":"绝对 ISO 日期/时间或 null","expiresAt":"绝对 ISO 时间或 null"}],"retire":[{"id":"要退出的原事项ID","status":"completed、cancelled 或 superseded","sourceAt":"${sourceAt}"}]}</live_attention_update>。只写本条用户消息直接支持的新增或变化；没有变化就省略标签。提问、假设、建议、助手自己说的话、检索到的旧材料都不能建立或更新事项。相对日期先依据这轮上下文换算为绝对北京时间；不能确定就留空，不能猜。完成/取消/被新事实替代的事项放入 retire；纠正要 supersede 旧项并新增修正后的项。不要把过去计划自动顺延。不要照抄旧更新标签作为证据。`
    : "本轮没有新的用户确认；不要创建、延后、完成或改写事项。";
  return {
    sourceAt,
    content: `<live_attention timezone="${timeZone}" current_at="${sourceAt}">${gap}${lines.length ? `\n当前事项：\n${lines.join("\n")}` : "\n当前没有已确认的有效事项。"}\n事项生命周期规则：只保留用户明确确认的当前事实/计划；完成、取消、被替代的事项退出；新纠正覆盖旧状态；已过期计划标记“完成情况未知”，绝不自动顺延；检索出的旧材料只供本轮回答，不能恢复成当前事实。\n${updateRule}\n</live_attention>`
  };
}

/**
 * Apply only narrowly validated updates from one model response. New or changed
 * records must cite the current user turn timestamp; terminal records are
 * removed rather than carried forward.
 */
export function applyLiveAttentionUpdate(raw, previousEvents = [], { now = Date.now(), sourceAt } = {}) {
  const match = String(raw || "").match(/<live_attention_update\b[^>]*>([\s\S]*?)<\/live_attention_update>/i);
  if (!match) return { events: previousEvents, changed: false, cleanText: String(raw || "") };
  let patch;
  try { patch = JSON.parse(match[1].trim()); }
  catch { return { events: previousEvents, changed: false, cleanText: String(raw || "").replace(match[0], "").trim() }; }

  const byId = new Map((Array.isArray(previousEvents) ? previousEvents : []).filter(event => event?.id).map(event => [event.id, event]));
  const next = new Map(byId);
  const currentSourceAt = validTime(sourceAt) ? new Date(sourceAt).toISOString() : "";
  let changed = false;

  for (const item of Array.isArray(patch.retire) ? patch.retire.slice(0, MAX_EVENTS) : []) {
    const id = normalizeId(item?.id, "");
    const status = String(item?.status || "");
    const at = validTime(item?.sourceAt) ? Date.parse(item.sourceAt) : NaN;
    if (next.has(id) && TERMINAL.has(status) && currentSourceAt && Math.abs(at - Date.parse(currentSourceAt)) <= 2 * 60_000) {
      next.delete(id);
      changed = true;
    }
  }

  for (const item of Array.isArray(patch.upsert) ? patch.upsert.slice(0, MAX_EVENTS) : []) {
    const event = normalizeEvent(item, now, byId, currentSourceAt);
    if (!event) continue;
    const before = next.get(event.id);
    if (JSON.stringify(before) !== JSON.stringify(event)) {
      next.set(event.id, event);
      changed = true;
    }
  }

  const events = [...next.values()]
    .filter(event => LIVE.has(event.status) && (!event.expiresAt || Date.parse(event.expiresAt) > now))
    .slice(-MAX_EVENTS);
  return {
    events,
    changed,
    cleanText: String(raw || "").replace(match[0], "").trim()
  };
}
