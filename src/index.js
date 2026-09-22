import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT || 8787);
const dataDir = process.env.LUMI_DATA_DIR || join(process.cwd(), "data");
const threadPath = join(dataDir, "threads.json");

const seed = () => ({
  id: "default",
  title: "沉小岑",
  messages: [{ id: randomUUID(), role: "assistant", content: "下午的风很轻，想和你说说话。", createdAt: new Date().toISOString() }]
});

async function readThreads() {
  await mkdir(dataDir, { recursive: true });
  try { return JSON.parse(await readFile(threadPath, "utf8")); }
  catch { const initial = { default: seed() }; await writeFile(threadPath, JSON.stringify(initial, null, 2)); return initial; }
}

async function saveThreads(threads) { await writeFile(threadPath, JSON.stringify(threads, null, 2)); }

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
    const match = url.pathname.match(/^\/v1\/chats\/([^/]+)(\/messages)?$/);
    if (!match) return send(res, 404, { error: "not_found" });
    const id = decodeURIComponent(match[1]);
    const threads = await readThreads();
    if (!threads[id]) threads[id] = { id, title: "新聊天", messages: [] };
    if (req.method === "GET" && !match[2]) return send(res, 200, threads[id]);
    if (req.method === "POST" && match[2]) {
      const input = await body(req);
      if (typeof input.content !== "string" || !input.content.trim()) return send(res, 400, { error: "content_required" });
      const userMessage = { id: randomUUID(), role: "user", content: input.content.trim(), createdAt: new Date().toISOString() };
      const assistantMessage = { id: randomUUID(), role: "assistant", content: "我想先听你说的这一句。", createdAt: new Date().toISOString() };
      threads[id].messages.push(userMessage, assistantMessage);
      await saveThreads(threads);
      return send(res, 200, { userMessage, assistantMessage });
    }
    return send(res, 405, { error: "method_not_allowed" });
  } catch (error) { return send(res, 500, { error: error.message }); }
});

server.listen(port, () => console.log(`Lumi server listening on :${port}`));
