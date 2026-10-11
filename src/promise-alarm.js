import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const alarmRoot = fileURLToPath(new URL("../promise-alarm/", import.meta.url));
export const promiseAlarmEnabled = process.env.LUMI_PROMISE_ALARM_ENABLED !== "false";
export const promiseAlarmToken = process.env.LUMI_PROMISE_ALARM_TOKEN || randomBytes(32).toString("hex");
export const promiseAlarmPort = Number(process.env.LUMI_PROMISE_ALARM_PORT || 18768);
let child = null;

export function startPromiseAlarm() {
  if (!promiseAlarmEnabled || child) return child;
  const apiURL = String(process.env.LUMI_MODEL_API_URL || "").replace(/\/?chat\/completions\/?$/i, "").replace(/\/$/, "");
  const dataDir = process.env.LUMI_DATA_DIR || join(process.cwd(), "data");
  child = spawn(process.env.PYTHON || process.env.PYTHON_EXECUTABLE || "python3", ["server.py"], {
    cwd: alarmRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PROMISE_PORT: String(promiseAlarmPort),
      PROMISE_DATA_DIR: join(dataDir, "promise-alarm"),
      PROMISE_API_BASE: process.env.PROMISE_API_BASE || apiURL,
      PROMISE_API_KEY: process.env.PROMISE_API_KEY || process.env.LUMI_MODEL_API_KEY || "",
      PROMISE_MODEL: process.env.PROMISE_MODEL || process.env.LUMI_MODEL_NAME || "",
      PROMISE_PERSONA: process.env.PROMISE_PERSONA || process.env.LUMI_SYSTEM_PROMPT || "你是 Lumi，像平时聊天一样自然地兑现你答应过的提醒。",
      PROMISE_UTC_OFFSET_HOURS: process.env.PROMISE_UTC_OFFSET_HOURS || "8",
      PROMISE_WEBHOOK_URL: `http://127.0.0.1:${process.env.PORT || 8787}/v1/internal/promise-alarm/fire`,
      PROMISE_WEBHOOK_TOKEN: promiseAlarmToken,
      PYTHONUNBUFFERED: "1"
    }
  });
  child.on("error", (error) => console.warn(`promise-alarm could not start: ${error.message}`));
  child.on("exit", (code, signal) => {
    child = null;
    if (code || signal) console.warn(`promise-alarm stopped (${signal || code})`);
  });
  return child;
}

export function stopPromiseAlarm() {
  child?.kill("SIGTERM");
}

export function promiseAlarmAuthorized(header) {
  const supplied = String(header || "").replace(/^Bearer\s+/i, "");
  const expected = promiseAlarmToken;
  return Boolean(supplied && supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)));
}

export async function promiseAlarmContext(sessionID) {
  if (!promiseAlarmEnabled) return "";
  try {
    const response = await fetch(`http://127.0.0.1:${promiseAlarmPort}/promises/context?session_id=${encodeURIComponent(sessionID)}`, { signal: AbortSignal.timeout(1200) });
    return response.ok ? await response.text() : "";
  } catch { return ""; }
}

export function capturePromiseAlarm(sessionID, userText, reply) {
  if (!promiseAlarmEnabled) return;
  const post = (path, payload) => fetch(`http://127.0.0.1:${promiseAlarmPort}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionID, ...payload }),
    signal: AbortSignal.timeout(95_000)
  });
  void (async () => {
    for (const [role, content] of [["user", userText], ["assistant", reply]]) {
      const stored = await post("/promises/message", { role, content });
      if (!stored.ok) throw new Error(`message sync HTTP ${stored.status}`);
    }
    const response = await post("/promises/capture", { user_text: userText, reply });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!["none", "skipped", "duplicate"].includes(result.outcome)) console.log(`promise-alarm: ${result.outcome}`);
  })().catch((error) => console.warn(`promise-alarm capture failed: ${error.message}`));
}

export function proxyPromiseAlarm(req, res, pathname, search = "") {
  if (!promiseAlarmEnabled) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "promise_alarm_disabled" }));
    return;
  }
  const upstream = httpRequest({ hostname: "127.0.0.1", port: promiseAlarmPort, method: req.method, path: `${pathname || "/"}${search}`, headers: { ...req.headers, host: `127.0.0.1:${promiseAlarmPort}`, origin: `http://127.0.0.1:${promiseAlarmPort}` } }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "promise_alarm_unavailable" }));
  });
  req.pipe(upstream);
}
