import { randomUUID } from "node:crypto";

const jobs = new Map();
const queue = [];
const previews = new Map();
const leaseMs = 45_000;
let agentSeenAt = 0;

export function markTakeoutAgentSeen() { agentSeenAt = Date.now(); }

export function takeoutAgentStatus() {
  return { connected: Date.now() - agentSeenAt < 40_000, lastSeenAt: agentSeenAt ? new Date(agentSeenAt).toISOString() : null };
}

export function saveTakeoutPreview(threadID, preview) {
  const id = String(threadID || "default");
  if (preview == null) previews.delete(id);
  else previews.set(id, preview);
}

export function getTakeoutPreview(threadID) {
  return previews.get(String(threadID || "default")) || null;
}

export function enqueueTakeoutJob(input, timeoutMs = 210_000) {
  if (!takeoutAgentStatus().connected) return Promise.resolve({ ok: false, stage: "本机连接", why: "Mac 外卖助手没有连接。请先启动本机外卖助手，并保持专用 Chrome 已登录。" });
  const id = randomUUID();
  return new Promise((resolve) => {
    const job = {
      id,
      input: sanitizeTakeoutInput(input),
      status: "queued",
      createdAt: Date.now(),
      resolve,
      timer: setTimeout(() => finishTakeoutJob(id, {
        ok: false,
        stage: "本机连接",
        why: "没有收到本机外卖助手的回应。请确认 Lumi 和专用 Chrome 都在运行。"
      }), timeoutMs)
    };
    jobs.set(id, job);
    queue.push(id);
  });
}

export function claimTakeoutJob() {
  markTakeoutAgentSeen();
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.status === "claimed" && now - job.claimedAt > leaseMs) job.status = "queued";
  }
  while (queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== "queued") continue;
    job.status = "claimed";
    job.claimedAt = now;
    return { id: job.id, input: job.input, createdAt: new Date(job.createdAt).toISOString() };
  }
  const job = [...jobs.values()].find((item) => item.status === "queued");
  if (!job) return null;
  job.status = "claimed";
  job.claimedAt = now;
  return { id: job.id, input: job.input, createdAt: new Date(job.createdAt).toISOString() };
}

export function finishTakeoutJob(id, result) {
  const job = jobs.get(String(id || ""));
  if (!job || job.status === "done") return false;
  clearTimeout(job.timer);
  job.status = "done";
  job.resolve(sanitizeTakeoutResult(result));
  setTimeout(() => jobs.delete(job.id), 5 * 60_000).unref?.();
  return true;
}

function sanitizeTakeoutInput(input = {}) {
  const allowed = ["kw", "dish", "shop", "qty", "addr", "规格", "max", "dry", "cart"];
  const value = Object.fromEntries(allowed.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
  value.kw = String(value.kw || value.dish || "").trim().slice(0, 80);
  value.shop = String(value.shop || "").trim().slice(0, 80);
  value.dish = String(value.dish || "").trim().slice(0, 80);
  value.qty = Math.max(1, Math.min(10, Math.floor(Number(value.qty) || 1)));
  const requestedMax = Number(value.max);
  value.max = Number.isFinite(requestedMax) ? Math.max(0.01, requestedMax) : Number.MAX_SAFE_INTEGER;
  value.dry = value.dry !== false;
  value.cart = value.cart === true;
  if (Array.isArray(value["规格"])) value["规格"] = value["规格"].slice(0, 8).map((item) => String(item).slice(0, 30));
  else delete value["规格"];
  return value;
}

function sanitizeTakeoutResult(result) {
  if (!result || typeof result !== "object") return { ok: false, stage: "本机连接", why: "外卖助手返回了无法识别的结果。" };
  const { shot } = result;
  const safe = {};
  for (const key of ["ok", "stage", "why", "amount", "paid", "shop", "items", "eta", "address", "previewOnly", "status"]) {
    if (result[key] !== undefined) safe[key] = result[key];
  }
  return {
    ...safe,
    order: result.order ? String(result.order).slice(0, 40) : undefined,
    shotAvailable: Boolean(shot)
  };
}
