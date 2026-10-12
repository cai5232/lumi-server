import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const file = () => process.env.LUMI_CALENDAR_FILE || `${process.env.LUMI_DATA_DIR || "data"}/calendar.json`;
const timezone = () => process.env.LUMI_CALENDAR_TIMEZONE || "Asia/Shanghai";
const pageDir = () => join(process.env.LUMI_DATA_DIR || "data", "calendar-pages");

function normalizedDateTime(value, precision = "time") {
  const source = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return `${source}T00:00:00+08:00`;
  if (!Number.isFinite(Date.parse(source))) return source;
  return source;
}

function normalizedEvent(event) {
  const precision = event.precision || "time";
  const starts = normalizedDateTime(event.starts_at, precision);
  const ends = event.ends_at ? normalizedDateTime(event.ends_at, precision) : new Date(Date.parse(starts) + (precision === "day" ? 86400000 : 3600000)).toISOString();
  return { description: null, timezone: timezone(), event_type: null, source: null, revision: 1, status: event.deleted_at ? "deleted" : "active", metadata: {}, ...event, starts_at: starts, ends_at: ends, created_by: event.created_by || "user" };
}

function queryBounds(from, to) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(from) ? Date.parse(`${from}T00:00:00+08:00`) : Date.parse(from);
  let end = /^\d{4}-\d{2}-\d{2}$/.test(to) ? Date.parse(`${to}T00:00:00+08:00`) + 86400000 : Date.parse(to);
  if (!Number.isFinite(end)) end = Number.MAX_SAFE_INTEGER;
  return { start: Number.isFinite(start) ? start : 0, end };
}

function dateInTimezone(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

async function readCalendar() {
  try {
    const state = JSON.parse(await readFile(file(), "utf8"));
    return { events: Array.isArray(state.events) ? state.events : [], notes: Array.isArray(state.notes) ? state.notes : [], changes: Array.isArray(state.changes) ? state.changes : [], seenChangeIds: Array.isArray(state.seenChangeIds) ? state.seenChangeIds : [] };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { events: [], notes: [], changes: [], seenChangeIds: [] };
  }
}

async function writeCalendar(state) {
  await mkdir(dirname(file()), { recursive: true });
  const temporary = `${file()}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2));
  await rename(temporary, file());
}

function recordChange(state, event, action) {
  state.changes.push({ id: state.changes.length ? Math.max(...state.changes.map(item => item.id)) + 1 : 1, event_id: event.id, action, actor: event.updated_by || event.created_by, snapshot: { ...event } });
  if (state.changes.length > 500) state.changes = state.changes.slice(-500);
}

function validTime(start, end) {
  const a = Date.parse(start), b = Date.parse(end);
  return Number.isFinite(a) && (!end || (Number.isFinite(b) && b > a));
}

export const calendarTools = [
  { name: "calendar_list", description: "查看指定日期范围的共享日历安排。", inputSchema: { type: "object", properties: { from: { type: "string", description: "起始日期 YYYY-MM-DD" }, to: { type: "string", description: "结束日期 YYYY-MM-DD" } } } },
  { name: "calendar_see", description: "查看某一天的共享手帐，包括事件、便签与手机页面渲染图。", inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, event_id: { type: "string", description: "可选，指定事件" } } } },
  { name: "calendar_create", description: "在共享日历上添加一条安排。", inputSchema: { type: "object", properties: { title: { type: "string" }, starts_at: { type: "string", description: "ISO 时间，全天事件可只传日期" }, ends_at: { type: "string", description: "可选 ISO 结束时间" }, precision: { type: "string", enum: ["time", "day"] }, event_type: { type: "string" }, note: { type: "string" } }, required: ["title", "starts_at"] } },
  { name: "calendar_update", description: "修改共享日历中的安排或便签，也可给便签点赞。", inputSchema: { type: "object", properties: { event_id: { type: "string" }, note_id: { type: "string" }, title: { type: "string" }, starts_at: { type: "string" }, ends_at: { type: "string" }, note: { type: "string" }, comment: { type: "string" }, liked: { type: "boolean" } } } },
  { name: "calendar_delete", description: "从共享日历移除一条安排或便签。", inputSchema: { type: "object", properties: { event_id: { type: "string" }, note_id: { type: "string" } } } },
  { name: "calendar_comment", description: "给某一天或某条安排贴一条便签。", inputSchema: { type: "object", properties: { date: { type: "string" }, event_id: { type: "string" }, comment: { type: "string" } }, required: ["comment"] } },
];

const mcpCalendarTool = {
  name: "calendar",
  description: "与你共用的手帐日历。可查看日期范围、查看单日及页面图片、增删改安排、贴便签和给便签点赞。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "see", "create", "update", "delete", "comment"] },
      from: { type: "string" }, to: { type: "string" }, date: { type: "string" },
      event_id: { type: "string" }, note_id: { type: "string" }, title: { type: "string" },
      starts_at: { type: "string" }, ends_at: { type: "string" }, precision: { type: "string", enum: ["time", "day"] },
      event_type: { type: "string" }, note: { type: "string" }, comment: { type: "string" }, liked: { type: "boolean" }
    }, required: ["action"]
  }
};

export async function calendarTool(name, args = {}) {
  const state = await readCalendar();
  const active = state.events.filter(event => !event.deleted_at);
  if (name === "calendar_list") {
    const from = args.from || new Date().toLocaleDateString("en-CA", { timeZone: timezone() });
    const to = args.to || from;
    const { start, end } = queryBounds(from, to);
    const events = active.filter(event => Date.parse(normalizedEvent(event).starts_at) < end && Date.parse(normalizedEvent(event).ends_at) > start).map(normalizedEvent);
    const notes = state.notes.filter(note => (note.anchor_date || note.date) >= from.slice(0, 10) && (note.anchor_date || note.date) <= to.slice(0, 10) && !note.deleted_at);
    const changes = state.changes.filter(change => !state.seenChangeIds.includes(change.id));
    state.seenChangeIds.push(...changes.map(change => change.id));
    await writeCalendar(state);
    return { events, notes, new_changes: changes };
  }
  if (name === "calendar_see") {
    const date = args.date || new Date().toLocaleDateString("en-CA", { timeZone: timezone() });
    const { start, end } = queryBounds(date, date);
    const events = active.filter(event => Date.parse(normalizedEvent(event).starts_at) < end && Date.parse(normalizedEvent(event).ends_at) > start).map(normalizedEvent);
    const notes = state.notes.filter(note => (note.anchor_date || note.date) === date && !note.deleted_at).map(note => ({ ...note, anchor_date: note.anchor_date || note.date, body: note.body || note.comment, author: note.author || note.created_by }));
    let pageImageBase64 = null;
    try { pageImageBase64 = (await readFile(join(pageDir(), `${date}.png`))).toString("base64"); } catch {}
    return { date, events: args.event_id ? events.filter(event => event.id === args.event_id) : events, notes, page_image_base64: pageImageBase64 };
  }
  if (name === "calendar_create") {
    const precision = args.precision === "day" ? "day" : args.precision || "time";
    const starts_at = normalizedDateTime(args.starts_at, precision);
    const ends_at = args.ends_at ? normalizedDateTime(args.ends_at, precision) : new Date(Date.parse(starts_at) + (precision === "day" ? 86400000 : 3600000)).toISOString();
    const event = { id: `cal_${randomUUID().replaceAll("-", "").slice(0, 16)}`, title: String(args.title || "").trim(), starts_at, ends_at, precision, event_type: args.event_type || null, note: args.note || "", created_by: args.created_by || "assistant", created_at: new Date().toISOString(), status: "active", revision: 1, metadata: args.metadata || {} };
    if (!event.title || !validTime(event.starts_at, event.ends_at)) throw new Error("title、有效开始时间和结束时间必须晚于开始时间");
    state.events.push(event); recordChange(state, event, "create"); await writeCalendar(state); return event;
  }
  if (["calendar_update", "calendar_delete"].includes(name)) {
    if (args.note_id) {
      const note = state.notes.find(item => item.id === args.note_id && !item.deleted_at);
      if (!note) throw new Error("日历便签不存在");
      if (name === "calendar_delete") note.deleted_at = new Date().toISOString();
      else {
        if (args.comment !== undefined) note.body = String(args.comment);
        if (args.liked !== undefined) note.liked = Boolean(args.liked);
        note.updated_at = new Date().toISOString();
      }
      const event = active.find(item => item.id === note.event_id);
      recordChange(state, event ? { ...event, note: note.body || note.comment, updated_by: args.updated_by || "assistant" } : { id: note.id, starts_at: note.anchor_date || note.date, title: note.body || note.comment, created_by: note.author || note.created_by || "assistant", updated_by: args.updated_by || "assistant" }, name === "calendar_delete" ? "note_delete" : args.liked !== undefined ? "like" : "note_update");
      await writeCalendar(state); return note;
    }
    const event = state.events.find(item => item.id === args.event_id && !item.deleted_at);
    if (!event) throw new Error("日历安排不存在");
    if (name === "calendar_delete") { event.deleted_at = new Date().toISOString(); event.updated_by = args.updated_by || "assistant"; event.status = "deleted"; recordChange(state, event, "delete"); }
    else { Object.assign(event, Object.fromEntries(["title", "starts_at", "ends_at", "note", "event_type", "precision", "metadata"].filter(key => args[key] !== undefined).map(key => [key, args[key]]))); if (args.starts_at) event.starts_at = normalizedDateTime(event.starts_at, event.precision); if (args.ends_at) event.ends_at = normalizedDateTime(event.ends_at, event.precision); event.updated_by = args.updated_by || "assistant"; event.updated_at = new Date().toISOString(); event.revision = Number(event.revision || 1) + 1; if (!validTime(event.starts_at, event.ends_at)) throw new Error("结束时间必须晚于开始时间"); recordChange(state, event, "update"); }
    await writeCalendar(state); return event;
  }
  if (name === "calendar_comment") {
    const event = args.event_id ? active.find(item => item.id === args.event_id) : null;
    if (args.event_id && !event) throw new Error("关联的日历安排不存在");
    const date = args.date || event?.starts_at.slice(0, 10);
    if (!date) throw new Error("需要提供 date 或 event_id");
    const note = { id: `note_${randomUUID().replaceAll("-", "").slice(0, 16)}`, date, anchor_date: date, event_id: event?.id || null, body: String(args.comment), comment: String(args.comment), y: null, liked: false, author: "assistant", created_by: "assistant", created_at: new Date().toISOString() };
    state.notes.push(note); recordChange(state, event ? { ...event, note: note.comment, updated_by: note.created_by } : { id: note.id, starts_at: date, anchor_date: date, title: note.comment, created_by: note.created_by }, "comment"); await writeCalendar(state); return note;
  }
  throw new Error("未知日历工具");
}

export async function calendarList(from, to) {
  const state = await readCalendar();
  const { start, end } = queryBounds(from, to);
  const events = state.events.filter(event => !event.deleted_at && Date.parse(normalizedEvent(event).starts_at) < end && Date.parse(normalizedEvent(event).ends_at) > start);
  const fromDay = dateInTimezone(from), toDay = dateInTimezone(to);
  const notes = state.notes.filter(note => (note.anchor_date || note.date) >= fromDay && (from === to ? (note.anchor_date || note.date) <= toDay : (note.anchor_date || note.date) < toDay) && !note.deleted_at);
  return { events: events.map(normalizedEvent), notes: notes.map(note => ({ ...note, anchor_date: note.anchor_date || note.date, body: note.body || note.comment, author: note.author || note.created_by })) };
}

export async function calendarEnvironment() {
  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: timezone() });
  const { events, notes } = await calendarList(today, today);
  const state = await readCalendar();
  const newChanges = state.changes.filter(change => !state.seenChangeIds.includes(change.id));
  const current = events.filter(event => event.precision !== "day" && Date.parse(event.starts_at) <= now && Date.parse(event.ends_at || new Date(Date.parse(event.starts_at) + 3600000)) > now);
  const lines = [...newChanges.map(change => `[NEW] ${change.actor} ${change.action}：「${change.snapshot.title || change.snapshot.note || "便签"}」`), ...current.map(event => `[NOW] ${event.title} (${event.created_by})`), ...events.filter(event => !current.includes(event)).map(event => `[TODAY] ${event.title} (${event.created_by})`), ...notes.map(note => `[TODAY] 便签：${note.comment} (${note.created_by})`)];
  return { text: lines.length ? `<calendar>\n${lines.join("\n")}\n</calendar>` : "", empty: !lines.length, change_ids: newChanges.map(change => change.id) };
}

export async function markCalendarChangesSeen(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const state = await readCalendar();
  state.seenChangeIds = [...new Set([...state.seenChangeIds, ...ids.map(Number).filter(Number.isFinite)])];
  await writeCalendar(state);
}

export async function extractCalendarMessage(text, messageId, callModel) {
  const source = String(text || "").trim();
  if (source.length < Number(process.env.LUMI_CALENDAR_EXTRACTOR_MIN_CHARS || 4)) return { ok: true, candidates_seen: 0, applied: [], skipped: [] };
  const state = await readCalendar();
  if (state.events.some(event => event.source_message_id === messageId)) return { ok: true, candidates_seen: 0, applied: [], skipped: [{ reason: "duplicate_message" }] };
  const timezoneName = timezone();
  const now = new Intl.DateTimeFormat("zh-CN", { timeZone: timezoneName, dateStyle: "full", timeStyle: "short" }).format(new Date());
  const raw = await callModel({
    messages: [
      { role: "system", content: `你是日历安排提取器。根据用户单独这一句话判断是否有已确定的、与用户本人有关的未来安排。忽略假设、建议、他人安排、重复习惯和已发生事项。当前时间：${now}（${timezoneName}）。只输出 JSON：{"events":[{"title":"简短标题","starts_at":"带时区的 ISO 时间或 YYYY-MM-DD","ends_at":"可选的带时区 ISO 时间或 YYYY-MM-DD","precision":"time 或 day","confidence":0.0}]}。没有明确安排时返回空 events。不要补充未说出的细节。` },
      { role: "user", content: source }
    ],
    provider: process.env.LUMI_CALENDAR_EXTRACTOR_PROVIDER || "zenmux",
    model: process.env.LUMI_CALENDAR_EXTRACTOR_MODEL || process.env.LUMI_MODEL_NAME || "",
    maxOutputTokens: 1200,
    mcpThreadId: "",
    mailThreadId: ""
  });
  let parsed = {};
  try { parsed = JSON.parse(String(raw).replace(/<thinking>[\s\S]*?<\/thinking>/g, "").match(/\{[\s\S]*\}/)?.[0] || "{}"); }
  catch { return { ok: false, error: "extractor_invalid_json", candidates_seen: 0, applied: [], skipped: [] }; }
  const candidates = Array.isArray(parsed.events) ? parsed.events : [];
  const applied = [], skipped = [];
  const confidenceFloor = Number(process.env.LUMI_CALENDAR_EXTRACTOR_MIN_CONFIDENCE || 0.65);
  for (const candidate of candidates.slice(0, 8)) {
    const confidence = Number(candidate.confidence || 0);
    const starts = String(candidate.starts_at || "");
    const ends = candidate.ends_at ? String(candidate.ends_at) : null;
    if (confidence < confidenceFloor) { skipped.push({ title: candidate.title || "", reason: "low_confidence" }); continue; }
    if (!String(candidate.title || "").trim() || !validTime(starts, ends)) { skipped.push({ title: candidate.title || "", reason: "invalid_candidate" }); continue; }
    const day = starts.slice(0, 10);
    const duplicate = state.events.some(event => !event.deleted_at && event.starts_at.slice(0, 10) === day && event.title.replace(/\s/g, "").includes(String(candidate.title).replace(/\s/g, "")));
    if (duplicate) { skipped.push({ title: candidate.title, reason: "duplicate" }); continue; }
    const event = { id: `cal_${randomUUID().replaceAll("-", "").slice(0, 16)}`, title: String(candidate.title).trim(), starts_at: starts, ends_at: ends, precision: candidate.precision === "day" ? "day" : "time", note: "", created_by: "auto", source_message_id: messageId, confidence, created_at: new Date().toISOString() };
    state.events.push(event); recordChange(state, event, "create"); applied.push(event);
  }
  if (applied.length) await writeCalendar(state);
  return { ok: true, candidates_seen: candidates.length, applied, skipped };
}

export async function calendarRoute(req, res, pathname, body, binary, extract, notify = null) {
  if (pathname === "/v1/calendar/mcp" && req.method === "POST") {
    const response = { jsonrpc: "2.0", id: body.id ?? null };
    if (body.method === "initialize") {
      response.result = { protocolVersion: body.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "lumi-calendar", version: "1.0.0" } };
    } else if (body.method === "tools/list") {
      response.result = { tools: [mcpCalendarTool] };
    } else if (body.method === "tools/call") {
      try {
        const suppliedName = body.params?.name;
        const args = body.params?.arguments || {};
        const actionName = suppliedName === "calendar" ? `calendar_${args.action || "see"}` : suppliedName;
        const result = await calendarTool(actionName, args);
        if (notify && ["calendar_create", "calendar_update", "calendar_delete", "calendar_comment"].includes(actionName)) await notify(actionName, result);
        const pageImage = result?.page_image_base64;
        if (pageImage) delete result.page_image_base64;
        response.result = { content: [{ type: "text", text: JSON.stringify(result) }, ...(pageImage ? [{ type: "image", data: pageImage, mimeType: "image/png" }] : [])] };
      } catch (error) {
        response.result = { content: [{ type: "text", text: String(error.message || error) }], isError: true };
      }
    } else {
      response.error = { code: -32601, message: "Method not found" };
    }
    return res(response);
  }
  const query = new URL(req.url, "http://localhost").searchParams;
  if (pathname === "/v1/calendar/events" && req.method === "GET") {
    const from = query.get("from") || new Date().toLocaleDateString("en-CA", { timeZone: timezone() });
    const to = query.get("to") || from;
    return res(await calendarList(from, to));
  }
  if (pathname === "/v1/calendar/events" && req.method === "POST") return res(normalizedEvent(await calendarTool("calendar_create", { ...body, created_by: "kitty" })), 201);
  if (pathname.startsWith("/v1/calendar/events/") && req.method === "PATCH") return res(normalizedEvent(await calendarTool("calendar_update", { ...body, updated_by: "kitty", event_id: decodeURIComponent(pathname.split("/").at(-1)) })));
  if (pathname.startsWith("/v1/calendar/events/") && req.method === "DELETE") return res(normalizedEvent(await calendarTool("calendar_delete", { updated_by: "kitty", event_id: decodeURIComponent(pathname.split("/").at(-1)) })));
  if (pathname === "/v1/calendar/notes" && req.method === "GET") {
    const singleDate = query.get("date");
    const from = singleDate || query.get("from") || "0000-00-00", to = singleDate || query.get("to") || "9999-99-99";
    const { notes } = await calendarList(from, to);
    return res({ notes });
  }
  if (pathname === "/v1/calendar/notes" && req.method === "POST") return res(await calendarTool("calendar_comment", { ...body, created_by: "kitty", date: body.anchor_date || body.date, comment: body.body || body.comment }), 201);
  if (pathname.startsWith("/v1/calendar/notes/") && req.method === "PATCH") {
    const state = await readCalendar(), id = decodeURIComponent(pathname.split("/").at(-1));
    const note = state.notes.find(item => item.id === id && !item.deleted_at);
    if (!note) return res({ error: "note_not_found" }, 404);
    if (body.body !== undefined) { note.body = String(body.body); note.comment = note.body; }
    if (body.anchor_date !== undefined) { note.anchor_date = String(body.anchor_date); note.date = note.anchor_date; }
    if (body.y !== undefined) note.y = body.y;
    if (body.liked !== undefined) note.liked = Boolean(body.liked);
    if (body.event_id !== undefined) note.event_id = body.event_id;
    note.updated_at = new Date().toISOString();
    const event = state.events.find(item => item.id === note.event_id && !item.deleted_at);
    recordChange(state, event ? { ...event, note: note.body || note.comment } : { id: note.id, starts_at: note.anchor_date || note.date, title: note.body || note.comment }, body.liked !== undefined ? "like" : "note_update");
    await writeCalendar(state);
    return res({ ...note, anchor_date: note.anchor_date || note.date, body: note.body || note.comment, author: note.author || note.created_by });
  }
  if (pathname.startsWith("/v1/calendar/notes/") && req.method === "DELETE") return res(await calendarTool("calendar_delete", { updated_by: "kitty", note_id: decodeURIComponent(pathname.split("/").at(-1)) }));
  if (pathname === "/v1/calendar/unseen" && req.method === "GET") {
    const state = await readCalendar();
    const days = [...new Set(state.changes.filter(change => !state.seenChangeIds.includes(change.id)).map(change => String(change.snapshot?.starts_at || change.snapshot?.anchor_date || "").slice(0, 10)).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))];
    return res({ days, count: days.length });
  }
  if (pathname === "/v1/calendar/unseen/seen" && req.method === "POST") {
    const state = await readCalendar(), date = String(body.date || "");
    state.seenChangeIds = [...new Set([...state.seenChangeIds, ...state.changes.filter(change => String(change.snapshot?.starts_at || change.snapshot?.anchor_date || "").startsWith(date)).map(change => change.id)])];
    await writeCalendar(state); return res({ cleared: true });
  }
  const pageMatch = pathname.match(/^\/v1\/calendar\/pages\/(\d{4}-\d{2}-\d{2})(?:\/render)?$/);
  if (pageMatch && req.method === "POST" && pathname.endsWith("/render")) {
    if (!Buffer.isBuffer(body) || body.length < 8 || body.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return res({ error: "invalid_calendar_page_png" }, 400);
    await mkdir(pageDir(), { recursive: true });
    await writeFile(join(pageDir(), `${pageMatch[1]}.png`), body);
    return res({ ok: true, date: pageMatch[1] }, 201);
  }
  if (pageMatch && req.method === "GET") {
    const image = await readFile(join(pageDir(), `${pageMatch[1]}.png`)).catch(() => null);
    if (!image) return res({ error: "page_not_found" }, 404);
    return binary(image, "image/png");
  }
  if (pathname === "/v1/calendar/env" && req.method === "GET") return res(await calendarEnvironment());
  if (pathname === "/v1/calendar/extract" && req.method === "POST") return res(await extract(body.text, body.message_id));
  return null;
}
