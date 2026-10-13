import { randomUUID } from "node:crypto";

const jobs = new Map();
const queue = [];
const previews = new Map();
const activeJobsByOwner = new Map();
const leaseMs = 12 * 60_000;
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

export function enqueueTakeoutJob(input, timeoutMs = 11 * 60_000) {
  if (!takeoutAgentStatus().connected) return Promise.resolve({ ok: false, stage: "本机连接", why: "Mac 外卖助手没有连接。请先启动本机外卖助手，并保持专用 Chrome 已登录。" });
  const owner = String(input.owner || "default").slice(0, 100);
  const activeId = activeJobsByOwner.get(owner);
  const activeJob = activeId ? jobs.get(activeId) : null;
  if (activeJob && activeJob.status !== "done") {
    return Promise.resolve({ ok: false, stage: "已有任务执行中", why: "上一笔外卖任务还没有得到最终结果。为避免重复下单，请先检查专用 Chrome 和订单记录，再发起新任务。", retryable: false });
  }
  const id = randomUUID();
  return new Promise((resolve) => {
    const job = {
      id,
      owner,
      input: sanitizeTakeoutInput(input),
      status: "queued",
      createdAt: Date.now(),
      resolve,
      timer: setTimeout(() => {
        const current = jobs.get(id);
        if (!current || current.status === "done") return;
        if (current.status === "queued") {
          current.status = "done";
          if (activeJobsByOwner.get(owner) === id) activeJobsByOwner.delete(owner);
          current.resolve(sanitizeTakeoutResult({ ok: false, stage: "本机连接", why: "本机助手没有接手这笔任务，没有提交订单。可以检查连接后重试。", retryable: true }));
          return;
        }
        current.timedOut = true;
        current.resolve(sanitizeTakeoutResult({ ok: false, stage: "订单状态待核实", why: "等待本机助手超时；它可能仍在处理。为避免重复下单，请先检查专用 Chrome 和订单记录，不要重试。", retryable: false }));
      }, timeoutMs)
    };
    jobs.set(id, job);
    activeJobsByOwner.set(owner, id);
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
  if (activeJobsByOwner.get(job.owner) === job.id) activeJobsByOwner.delete(job.owner);
  if (!job.timedOut) job.resolve(sanitizeTakeoutResult(result));
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
  for (const key of ["ok", "stage", "why", "amount", "paid", "shop", "items", "eta", "address", "previewOnly", "status", "retryable", "paidAmountVerified"]) {
    if (result[key] !== undefined) safe[key] = result[key];
  }
  return {
    ...safe,
    order: result.order ? String(result.order).slice(0, 40) : undefined,
    shotAvailable: Boolean(shot)
  };
}
