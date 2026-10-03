import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const dataDir = process.env.LUMI_DATA_DIR || join(process.cwd(), "data");
const sentMailPath = join(dataDir, "sent-mail.jsonl");
let writeTail = Promise.resolve();

export function normalizeMailThreadId(value) {
  const id = String(value || "default").trim();
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : "default";
}

async function records() {
  await writeTail.catch(() => {});
  let source;
  try { source = await readFile(sentMailPath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return source.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const record = JSON.parse(line);
      return record && typeof record === "object" ? [record] : [];
    } catch { return []; }
  });
}

export async function recordSentMail({ threadId, to, cc = "", subject, body, messageId = "", accepted = [] }) {
  const record = {
    id: randomUUID(), threadId: normalizeMailThreadId(threadId),
    sentAt: new Date().toISOString(), to, cc, subject, body, messageId, accepted
  };
  writeTail = writeTail.catch(() => {}).then(async () => {
    await mkdir(dirname(sentMailPath), { recursive: true });
    await appendFile(sentMailPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
  await writeTail;
  return record;
}

export async function searchSentMail({ threadId = "default", query = "", limit = 10 } = {}) {
  const id = normalizeMailThreadId(threadId);
  const needle = String(query || "").trim().toLowerCase();
  const count = Math.max(1, Math.min(30, Number(limit) || 10));
  return (await records())
    .filter((record) => record.threadId === id &&
      (!needle || [record.to, record.cc, record.subject, record.body].some((part) => String(part || "").toLowerCase().includes(needle))))
    .reverse().slice(0, count)
    .map(({ id, sentAt, to, cc, subject, body, messageId }) =>
      ({ id, sentAt, to, cc, subject, bodyPreview: String(body || "").slice(0, 500), messageId }));
}

export async function readSentMail({ threadId = "default", id }) {
  const record = (await records()).findLast((item) =>
    item.threadId === normalizeMailThreadId(threadId) && item.id === String(id || ""));
  if (!record) throw new Error("已发送邮件记录不存在");
  return record;
}
