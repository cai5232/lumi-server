import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MIN_INTERVAL_MS = 120_000;
const HOURLY_LIMIT = 12;
const DAILY_LIMIT = 40;
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 2_000;

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function validId(value) {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

function cleanText(value, limit) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) : "";
}

function filterSensitiveText(value) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[已过滤]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[已过滤]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[已过滤]")
    .replace(/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\b["']?\s*[:=]\s*["']?[^"'\s,}]+/gi, "[已过滤]");
}

function validateObservation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const allowed = new Set(["appName", "bundleIdentifier", "windowTitle", "activityType", "selectedText", "observedAt"]);
  if (Object.keys(input).some(key => !allowed.has(key))) return null;
  if (typeof input.appName !== "string" || typeof input.bundleIdentifier !== "string") return null;
  const observedAt = Date.parse(input.observedAt || "");
  if (!Number.isFinite(observedAt) || Math.abs(Date.now() - observedAt) > 10 * 60_000) return null;
  const activityType = ["reading", "coding", "unknown"].includes(input.activityType) ? input.activityType : "unknown";
  return {
    appName: cleanText(input.appName, 80),
    bundleIdentifier: cleanText(input.bundleIdentifier, 200),
    windowTitle: filterSensitiveText(cleanText(input.windowTitle, 180)),
    activityType,
    selectedText: filterSensitiveText(cleanText(input.selectedText, 1_200)),
    observedAt: new Date(observedAt).toISOString()
  };
}

function normalizeDecision(raw) {
  if (typeof raw !== "string" || raw.length > 8_000) return null;
  const text = raw.trim();
  if (text.startsWith("```") || text.includes("```")) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.shouldSpeak !== "boolean") return null;
  const content = value.shouldSpeak ? cleanText(value.content, 280) : "";
  if (value.shouldSpeak && !content) return null;
  const suggested = Number(value.suggestedNextCheckSeconds);
  const suggestedNextCheckSeconds = Number.isFinite(suggested)
    ? Math.max(120, Math.min(3_600, Math.round(suggested)))
    : 600;
  const reasonCode = typeof value.reasonCode === "string" && /^[a-z0-9_]{1,48}$/i.test(value.reasonCode)
    ? value.reasonCode
    : "unspecified";
  return { shouldSpeak: value.shouldSpeak, content, suggestedNextCheckSeconds, reasonCode };
}

export function createDesktopCompanionService({ dataDir, pairingToken = () => "", generate, onContext = async () => {}, now = () => Date.now(), isSecure = () => false }) {
  const storePath = join(dataDir, "desktop-companion.json");
  const inFlightDevices = new Set();
  let mutationQueue = Promise.resolve();

  async function readState() {
    try {
      const state = JSON.parse(await readFile(storePath, "utf8"));
      return { devices: Array.isArray(state.devices) ? state.devices : [], events: Array.isArray(state.events) ? state.events : [] };
    } catch (error) {
      if (error?.code === "ENOENT") return { devices: [], events: [] };
      throw error;
    }
  }

  async function writeState(state) {
    await mkdir(dataDir, { recursive: true });
    const temporary = `${storePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, storePath);
  }

  async function mutate(operation) {
    const previous = mutationQueue;
    let release;
    mutationQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const state = await readState();
      const result = await operation(state);
      await writeState(state);
      return result;
    } finally {
      release();
    }
  }

  function pairAuthorized(headers) {
    const configured = String(typeof pairingToken === "function" ? pairingToken() : pairingToken || "");
    const supplied = String(headers.authorization || "").replace(/^Bearer\s+/i, "");
    return configured.length >= 32 && secureEqual(configured, supplied);
  }

  async function deviceFor(headers, deviceId) {
    const supplied = String(headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!supplied || !validId(deviceId)) return null;
    const state = await readState();
    const device = state.devices.find(item => item.id === deviceId && !item.revokedAt);
    if (!device) return null;
    return secureEqual(digest(supplied), device.tokenHash) ? device : null;
  }

  async function pair(body) {
    if (!pairAuthorized(body.headers)) return { status: 401, body: { error: "unauthorized" } };
    const input = body.body;
    const conversationId = typeof input?.conversationId === "string" ? input.conversationId : "default";
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(conversationId)) return { status: 400, body: { error: "invalid_conversation_id" } };
    const activeCount = await readState().then(state => state.devices.filter(item => !item.revokedAt).length);
    if (activeCount >= 20) return { status: 429, body: { error: "device_limit_reached" } };
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const device = {
      id,
      name: cleanText(input?.deviceName || "Lumi Desktop Companion", 80),
      conversationId,
      tokenHash: digest(token),
      createdAt: new Date(now()).toISOString(),
      revokedAt: null
    };
    await mutate(state => { state.devices.push(device); });
    return { status: 201, body: { deviceId: id, deviceToken: token, conversationId } };
  }

  async function revoke(body, deviceId) {
    if (!pairAuthorized(body.headers) && !(await deviceFor(body.headers, deviceId))) return { status: 401, body: { error: "unauthorized" } };
    const result = await mutate(state => {
      const device = state.devices.find(item => item.id === deviceId && !item.revokedAt);
      if (!device) return false;
      device.revokedAt = new Date(now()).toISOString();
      return true;
    });
    return result ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "device_not_found" } };
  }

  async function observe(request) {
    const input = request.body;
    if (!input || Object.keys(input).some(key => !["deviceId", "eventId", "observation", "force"].includes(key)) || !validId(input.deviceId) || !validId(input.eventId) || (input.force !== undefined && typeof input.force !== "boolean")) {
      return { status: 400, body: { error: "invalid_request" } };
    }
    const force = input.force === true;
    const observation = validateObservation(input.observation);
    if (!observation || !observation.appName || !observation.bundleIdentifier) return { status: 400, body: { error: "invalid_observation" } };
    const device = await deviceFor(request.headers, input.deviceId);
    if (!device) return { status: 401, body: { error: "unauthorized" } };
    // Persist only a hash of event metadata. Screen text is never written, even
    // as a stable digest that could be guessed offline.
    const fingerprint = digest(JSON.stringify({ ...observation, selectedText: "" }));
    const eventKey = `${device.id}:${input.eventId}`;

    const reservation = await mutate(state => {
      const duplicate = state.events.find(event => event.id === eventKey);
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) return { kind: "conflict" };
        return { kind: "duplicate", event: duplicate };
      }
      const timestamp = now();
      const pending = state.events.some(event => event.deviceId === device.id && event.deliveryStatus === "pending" && Date.parse(event.generatedAt) > timestamp - 2 * 60_000);
      if (pending || inFlightDevices.has(device.id)) return { kind: "busy" };
      const recent = state.events.filter(event => event.deviceId === device.id && Date.parse(event.generatedAt) > timestamp - 60 * 60_000);
      const today = state.events.filter(event => event.deviceId === device.id && Date.parse(event.generatedAt) > timestamp - 24 * 60 * 60_000);
      const last = recent.reduce((latest, event) => Math.max(latest, Date.parse(event.generatedAt) || 0), 0);
      if (!force && timestamp - last < MIN_INTERVAL_MS) return { kind: "cooldown" };
      if (recent.length >= HOURLY_LIMIT || today.length >= DAILY_LIMIT) return { kind: "budget" };
      inFlightDevices.add(device.id);
      state.events.push({ id: eventKey, fingerprint, deviceId: device.id, conversationId: device.conversationId, observedAt: observation.observedAt, generatedAt: new Date(timestamp).toISOString(), appName: observation.appName, eventType: "observation", content: "", reasonCode: "", deliveryStatus: "pending" });
      return { kind: "reserved" };
    });

    if (reservation.kind === "conflict") return { status: 409, body: { error: "event_id_reused" } };
    if (reservation.kind === "duplicate") {
      const event = reservation.event;
      if (event.deliveryStatus === "pending") return { status: 409, body: { error: "event_in_progress" } };
      if (event.deliveryStatus === "failed") return { status: 503, body: { error: "generation_failed", duplicate: true } };
      return { status: 200, body: { ...event.result, duplicate: true } };
    }
    if (reservation.kind === "cooldown") return { status: 429, body: { error: "cooldown" } };
    if (reservation.kind === "budget") return { status: 429, body: { error: "request_budget_reached" } };
    if (reservation.kind === "busy") return { status: 409, body: { error: "device_request_in_progress" } };

    try {
      const raw = await generate({ conversationId: device.conversationId, observation });
      const decision = normalizeDecision(raw);
      if (!decision) throw new Error("invalid_structured_output");
      await onContext({ conversationId: device.conversationId, observation, decision, generatedAt: new Date(now()).toISOString() });
      const result = await mutate(state => {
        const event = state.events.find(item => item.id === eventKey);
        if (!event) throw new Error("event_reservation_lost");
        event.content = decision.content;
        event.reasonCode = decision.reasonCode;
        event.deliveryStatus = "generated";
        event.result = decision;
        state.events = state.events.filter(item => Date.parse(item.generatedAt) > now() - EVENT_RETENTION_MS).slice(-MAX_EVENTS);
        return decision;
      });
      return { status: 200, body: result };
    } catch {
      await mutate(state => {
        const event = state.events.find(item => item.id === eventKey);
        if (event) event.deliveryStatus = "failed";
        state.events = state.events.filter(item => Date.parse(item.generatedAt) > now() - EVENT_RETENTION_MS).slice(-MAX_EVENTS);
      });
      return { status: 503, body: { error: "generation_failed" } };
    } finally {
      inFlightDevices.delete(device.id);
    }
  }

  return {
    async handle({ method, path, headers = {}, body: input = {}, secure = false }) {
      if (!secure) return { status: 426, body: { error: "https_required" } };
      const request = { headers, body: input };
      if (method === "POST" && path === "/v1/companion/devices") return pair(request);
      const devicePath = path.match(/^\/v1\/companion\/devices\/([a-f0-9-]{36})$/i);
      if (method === "DELETE" && devicePath) return revoke(request, devicePath[1]);
      if (method === "POST" && path === "/v1/companion/observe") return observe(request);
      return { status: 404, body: { error: "not_found" } };
    }
  };
}

export { filterSensitiveText, normalizeDecision, validateObservation };
