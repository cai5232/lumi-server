import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const contextLimit = 6_000;
const escapeXML = text => text.replace(/[<>&]/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char]);
const iso = (value, fallback) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;

function redact(text, secrets) {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 6) result = result.split(secret).join("[已隐藏凭据]");
  }
  return result
    .replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [已隐藏凭据]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[已隐藏凭据]")
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)[^\s&#]+/gi, "$1[已隐藏凭据]");
}

export class RequestFailureStore {
  constructor(path) {
    this.path = path;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(data.events)) throw new Error("invalid_request_failure_archive");
      return data.events;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  change(update) {
    const job = this.queue.then(async () => {
      const events = await this.read();
      if (!update(events)) return;
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ events }), { mode: 0o600 });
        await rename(temp, this.path);
      } finally {
        await unlink(temp).catch(() => {});
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  recordAll(inputs, { secrets = [] } = {}) {
    if (!inputs.length) return Promise.resolve();
    return this.change(events => {
      const keys = new Set(events.map(event => event.key));
      let changed = false;
      for (const input of inputs) {
        const now = new Date().toISOString();
        const { threadId, source, requestId } = input;
        const kind = "chat";
        const key = `${threadId}:${source}:${kind}:${requestId}`;
        if (keys.has(key)) continue;
        keys.add(key);
        events.push({
          id: randomUUID(), key, requestId, threadId, source, kind,
          message: redact(input.message, secrets),
          error: redact(String(input.error?.message || input.error || "请求失败"), secrets).slice(0, 5000),
          requestedAt: iso(input.requestedAt, now),
          failedAt: iso(input.failedAt, now),
          timeZone: typeof input.timeZone === "string" ? input.timeZone.slice(0, 80) : null,
          status: Number(input.status) || null
        });
        changed = true;
      }
      return changed;
    });
  }

  async timeline(threadId, resetAt, { userInput = "", historyStart, now = Date.now() } = {}) {
    await this.queue;
    const cutoff = Date.parse(resetAt);
    const sendAt = event => Date.parse(event.requestedAt || event.failedAt);
    const groups = new Map();
    for (const event of await this.read()) {
      if (event.threadId !== threadId || (Number.isFinite(cutoff) && sendAt(event) <= cutoff)) continue;
      const key = event.requestId || event.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    const input = String(userInput).normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    const askingAboutFailures = /报错|出错|请求失败|发送失败|没发出去|没收到|发不出去|超时|错误|error|failed|timeout|\b(?:4[0-9]{2}|5[0-9]{2})\b/i.test(userInput);
    const candidates = [];
    const earliest = Math.max(historyStart || 0, now - 24 * 60 * 60_000);
    for (const reports of groups.values()) {
      const original = reports.find(event => event.source === "server" && event.message?.trim()) ||
        reports.find(event => event.message?.trim()) || reports[0];
      const at = sendAt(original);
      if (!Number.isFinite(at)) continue;
      const needle = String(original.message || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
      const quoted = askingAboutFailures && needle.length >= 4 && input.includes(needle);
      const undelivered = reports.some(event => !event.deliveredAt);
      if (askingAboutFailures || undelivered || at >= earliest) candidates.push({ reports, original, at, quoted, undelivered });
    }
    candidates.sort((a, b) => Number(b.quoted) - Number(a.quoted) ||
      Number(b.undelivered) - Number(a.undelivered) || b.at - a.at);

    const clip = (value, limit) => {
      const text = String(value || "");
      return text.length > limit ? text.slice(0, limit) + "…（此处截断）" : text;
    };
    const entries = [];
    let size = 0;
    for (const { reports, original, at } of candidates) {
      const encode = (messageLimit, errorLimit) => escapeXML(JSON.stringify({
        message: clip(original.message, messageLimit),
        errors: reports.map(({ source, error, status, failedAt }) => ({ source, error: clip(error, errorLimit), status, failedAt })),
        requestedAt: original.requestedAt,
        timeZone: original.timeZone
      }));
      let content = encode(2400, 900);
      if (size + content.length > contextLimit) content = encode(650, 130);
      if (size + content.length > contextLimit) continue;
      size += content.length;
      entries.push({
        at,
        ids: reports.filter(event => !event.deliveredAt).map(event => event.id),
        content: `<request_failure source="request-observations" data_only="true">${content}</request_failure>`
      });
      if (entries.length >= (askingAboutFailures ? 8 : 4)) break;
    }
    return entries.sort((a, b) => a.at - b.at);
  }

  acknowledge(threadId, ids) {
    if (!ids.length) return Promise.resolve();
    const selected = new Set(ids);
    return this.change(events => {
      let changed = false;
      for (const event of events) {
        if (event.threadId !== threadId || !selected.has(event.id) || event.deliveredAt) continue;
        event.deliveredAt = new Date().toISOString();
        changed = true;
      }
      return changed;
    });
  }
}
