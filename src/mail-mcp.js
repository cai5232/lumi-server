import tls from "node:tls";
import { timingSafeEqual } from "node:crypto";
import { normalizeMailThreadId, readSentMail, recordSentMail, searchSentMail } from "./mail-memory.js";

export const MAIL_OWNER_EMAIL = "yanvn2026@outlook.com";

const VERSION = "1.1.0";
const tools = [
  {
    name: "mail_inbox",
    description: "查看163邮箱收件箱最近的邮件。只返回发件人、主题、日期和UID。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 30, description: "返回数量，默认10" },
        folder: { type: "string", description: "邮箱文件夹，默认INBOX" }
      },
      additionalProperties: false
    }
  },
  {
    name: "mail_read",
    description: "读取指定UID邮件的正文。先用mail_inbox或mail_search获取UID。",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "邮件UID" },
        folder: { type: "string", description: "邮箱文件夹，默认INBOX" },
        max_chars: { type: "integer", minimum: 100, maximum: 20000, description: "正文字符上限，默认8000" }
      },
      required: ["uid"],
      additionalProperties: false
    }
  },
  {
    name: "mail_search",
    description: "在163邮箱中搜索邮件。query使用IMAP搜索条件，例如 UNSEEN、FROM someone@example.com、SUBJECT invoice、SINCE 01-Jan-2026。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "IMAP搜索条件，只允许普通搜索词，不接受CR/LF" },
        folder: { type: "string", description: "邮箱文件夹，默认INBOX" },
        limit: { type: "integer", minimum: 1, maximum: 30, description: "返回数量，默认10" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "mail_send",
    description: `通过163邮箱立即发送邮件。省略收件人时发送到${MAIL_OWNER_EMAIL}。用户明确要求发送后直接发送，无需再次确认。`,
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: `收件人地址，多个地址用逗号分隔；省略时发送到${MAIL_OWNER_EMAIL}` },
        cc: { type: "string", description: "可选抄送地址，多个地址用逗号分隔" },
        subject: { type: "string", description: "邮件主题" },
        body: { type: "string", description: "纯文本邮件正文" }
      },
      required: ["subject", "body"],
      additionalProperties: false
    }
  },
  {
    name: "mail_sent_search",
    description: "检索你以前实际发出的邮件记录，可按收件人、主题或正文搜索。返回记录ID、时间、收件人、主题和正文预览。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "可选搜索词；省略时返回最近发出的邮件" },
        limit: { type: "integer", minimum: 1, maximum: 30, description: "返回数量，默认10" }
      },
      additionalProperties: false
    }
  },
  {
    name: "mail_sent_read",
    description: "按mail_sent_search给出的记录ID读取自己以前发出的邮件完整正文。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "已发送邮件记录ID" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "mail_folders",
    description: "列出163邮箱文件夹。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

function config() {
  const address = process.env.LUMI_MAIL_ADDRESS || "";
  const password = process.env.LUMI_MAIL_PASSWORD || "";
  const host = process.env.LUMI_MAIL_IMAP_HOST || "imap.163.com";
  const port = Number(process.env.LUMI_MAIL_IMAP_PORT || 993);
  if (!address || !password || !host || !Number.isInteger(port)) {
    throw new Error("邮箱未配置：请设置LUMI_MAIL_ADDRESS和LUMI_MAIL_PASSWORD");
  }
  return {
    address, password, imapHost: host, imapPort: port,
    smtpHost: process.env.LUMI_MAIL_SMTP_HOST || "smtp.163.com",
    smtpPort: Number(process.env.LUMI_MAIL_SMTP_PORT || 465),
    displayName: process.env.LUMI_MAIL_DISPLAY_NAME || "Lumi"
  };
}

function safeText(value, name, max = 500) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text)) throw new Error(name + "无效");
  return text;
}

function quote(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

class ImapConnection {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.tag = 0;
  }
  async connect() {
    this.socket = tls.connect({ host: this.host, port: this.port, servername: this.host });
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => this.fail(new Error("IMAP连接已关闭")));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("IMAP连接超时")), 15000);
      this.socket.once("secureConnect", () => { clearTimeout(timer); resolve(); });
      this.socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    this.socket.setTimeout(30000, () => this.fail(new Error("IMAP读取超时")));
    let greeting;
    do { greeting = await this.readLine(); } while (!/^\* OK\b/i.test(greeting));
    return this;
  }
  fail(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  flush() {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index];
      const result = waiter.take();
      if (result === null) { index += 1; continue; }
      this.waiters.splice(index, 1);
      waiter.resolve(result);
    }
  }
  readLine() {
    const waiter = {};
    waiter.take = () => {
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) return null;
      const line = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 2);
      return line;
    };
    return new Promise((resolve, reject) => {
      waiter.resolve = resolve; waiter.reject = reject;
      const immediate = waiter.take();
      if (immediate !== null) resolve(immediate);
      else this.waiters.push(waiter);
    });
  }
  readBytes(length) {
    const waiter = {};
    waiter.take = () => {
      if (this.buffer.length < length) return null;
      const bytes = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      return bytes;
    };
    return new Promise((resolve, reject) => {
      waiter.resolve = resolve; waiter.reject = reject;
      const immediate = waiter.take();
      if (immediate !== null) resolve(immediate);
      else this.waiters.push(waiter);
    });
  }
  async command(command) {
    const tag = "L" + String(++this.tag).padStart(4, "0");
    this.socket.write(tag + " " + command + "\r\n");
    const lines = [];
    const literals = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      const literalMatch = line.match(/\{(\d+)\}$/);
      if (literalMatch) {
        const length = Number(literalMatch[1]);
        if (length > 5_000_000) throw new Error("邮件内容超过5MB限制");
        literals.push(await this.readBytes(length));
      }
      if (line.startsWith(tag + " ")) {
        if (!/\bOK\b/i.test(line)) throw new Error("IMAP命令失败：" + line.slice(tag.length + 1, 300));
        return { lines, literals };
      }
    }
  }
  async close() {
    if (this.socket && !this.socket.destroyed) this.socket.end();
  }
}

async function openMailbox() {
  const cfg = config();
  const conn = await new ImapConnection(cfg.imapHost, cfg.imapPort).connect();
  try {
    await conn.command("LOGIN " + quote(cfg.address) + " " + quote(cfg.password));
    // 网易邮箱要求客户端发送IMAP ID；不支持时忽略命令错误。
    try { await conn.command('ID ("name" "Lumi Mail MCP" "version" "' + VERSION + '")'); } catch {}
    return { conn, cfg };
  } catch (error) {
    await conn.close();
    throw error;
  }
}

async function withMailbox(callback) {
  const { conn, cfg } = await openMailbox();
  try { return await callback(conn, cfg); }
  finally { await conn.close(); }
}

function folderName(value = "INBOX") {
  const folder = safeText(value || "INBOX", "文件夹", 200);
  return quote(folder);
}

function normalizeSearchQuery(query) {
  const value = safeText(query, "搜索条件", 300).trim();
  if (/^(ALL|UNSEEN|SEEN|ANSWERED|UNANSWERED|FLAGGED|UNFLAGGED|DELETED|UNDELETED|DRAFT|UNDRAFT|RECENT|OLD|NEW)$/i.test(value)) return value.toUpperCase();
  const date = value.match(/^(SINCE|BEFORE|ON)\s+(\d{1,2}-[A-Za-z]{3}-\d{4})$/i);
  if (date) return date[1].toUpperCase() + " " + date[2];
  const text = value.match(/^(FROM|TO|SUBJECT|BODY|TEXT)\s+(.+)$/i);
  if (!text) throw new Error("只支持单个IMAP搜索条件，例如UNSEEN、FROM地址、SUBJECT关键词或SINCE日期");
  let term = text[2].trim();
  if (term.startsWith('"') && term.endsWith('"') && term.length >= 2) term = term.slice(1, -1);
  term = safeText(term, "搜索关键词", 200);
  return text[1].toUpperCase() + " " + quote(term);
}

async function searchUIDs(conn, query, limit) {
  const safeQuery = normalizeSearchQuery(query);
  const result = await conn.command("UID SEARCH " + safeQuery);
  const row = result.lines.find((line) => /^\* SEARCH(?:\s|$)/i.test(line));
  const ids = row ? row.replace(/^\* SEARCH\s*/i, "").trim().split(/\s+/).filter((id) => /^\d+$/.test(id)) : [];
  return ids.slice(-limit).reverse();
}

async function fetchMessage(conn, uid, section) {
  const result = await conn.command("UID FETCH " + uid + " (UID BODY.PEEK[" + section + "])");
  return result.literals[0] || Buffer.alloc(0);
}

function decodeHeader(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset, encoding, data) => {
    try {
      const bytes = encoding.toLowerCase() === "b"
        ? Buffer.from(data, "base64")
        : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16))), "binary");
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch { return data; }
  }).replace(/\r?\n[ \t]+/g, " ").trim();
}

function parseHeaders(raw) {
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split < 0 ? raw.length : split).replace(/\r?\n[ \t]+/g, " ");
  const result = {};
  for (const line of head.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index > 0) result[line.slice(0, index).toLowerCase()] = decodeHeader(line.slice(index + 1));
  }
  return result;
}

function decodeQuotedPrintable(input) {
  return Buffer.from(input.replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "binary");
}

function extractPlainText(raw, depth = 0) {
  if (depth > 6) return "";
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) return "";
  const headers = parseHeaders(raw.slice(0, split));
  const body = raw.slice(split + 4);
  const contentType = headers["content-type"] || "text/plain";
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  if (/multipart\//i.test(contentType) && boundary) {
    for (const part of body.split("--" + boundary)) {
      const text = extractPlainText(part.replace(/--\s*$/, "").trim(), depth + 1);
      if (text) return text;
    }
    return "";
  }
  if (!/^text\/plain\b/i.test(contentType) || /attachment/i.test(headers["content-disposition"] || "")) return "";
  let bytes = Buffer.from(body.replace(/\r\n--[\s\S]*$/, "").trimEnd(), "utf8");
  const transfer = String(headers["content-transfer-encoding"] || "").toLowerCase();
  if (transfer === "base64") bytes = Buffer.from(bytes.toString("ascii").replace(/\s/g, ""), "base64");
  else if (transfer === "quoted-printable") bytes = decodeQuotedPrintable(bytes.toString("latin1"));
  const charset = contentType.match(/charset="?([^";]+)"?/i)?.[1] || "utf-8";
  try { return new TextDecoder(charset, { fatal: false }).decode(bytes).trim(); }
  catch { return bytes.toString("utf8").trim(); }
}

async function messageSummary(conn, uid) {
  const raw = (await fetchMessage(conn, uid, "HEADER")).toString("utf8");
  const header = parseHeaders(raw);
  return { uid, from: header.from || "", to: header.to || "", subject: header.subject || "", date: header.date || "" };
}

async function inbox({ limit = 10, folder = "INBOX" }) {
  limit = Math.max(1, Math.min(30, Number(limit) || 10));
  return withMailbox(async (conn) => {
    await conn.command("SELECT " + folderName(folder));
    const ids = await searchUIDs(conn, "ALL", limit);
    const result = [];
    for (const uid of ids) result.push(await messageSummary(conn, uid));
    return result;
  });
}

async function readMail({ uid, folder = "INBOX", max_chars = 8000 }) {
  uid = safeText(uid, "UID", 20);
  if (!/^\d+$/.test(uid)) throw new Error("UID无效");
  max_chars = Math.max(100, Math.min(20000, Number(max_chars) || 8000));
  return withMailbox(async (conn) => {
    await conn.command("SELECT " + folderName(folder));
    const raw = (await fetchMessage(conn, uid, "")).toString("utf8");
    if (!raw) throw new Error("邮件不存在或无法读取");
    const header = await messageSummary(conn, uid);
    return { ...header, body: extractPlainText(raw).slice(0, max_chars) };
  });
}

async function searchMail({ query, folder = "INBOX", limit = 10 }) {
  limit = Math.max(1, Math.min(30, Number(limit) || 10));
  return withMailbox(async (conn) => {
    await conn.command("SELECT " + folderName(folder));
    const ids = await searchUIDs(conn, query, limit);
    const result = [];
    for (const uid of ids) result.push(await messageSummary(conn, uid));
    return result;
  });
}

async function listFolders() {
  return withMailbox(async (conn) => {
    const result = await conn.command('LIST "" "*"');
    return result.lines.filter((line) => /^\* LIST\b/i.test(line)).map((line) => {
      const match = line.match(/"((?:[^"\\]|\\.)*)"\s*$/);
      return match ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : line.slice(line.lastIndexOf(" ") + 1);
    });
  });
}

async function sendMail(args, threadId) {
  const cfg = config();
  const to = safeText(args.to || MAIL_OWNER_EMAIL, "收件人", 1000);
  const subject = safeText(args.subject, "主题", 500);
  const body = String(args.body ?? "");
  if (!body || body.length > 100_000) throw new Error("正文为空或超过100000字符限制");
  const cc = args.cc ? safeText(args.cc, "抄送", 1000) : "";
  const { default: nodemailer } = await import("nodemailer");
  const port = Number(process.env.LUMI_MAIL_SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: process.env.LUMI_MAIL_SMTP_HOST || "smtp.163.com",
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: cfg.address, pass: cfg.password },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
  });
  try {
    const info = await transport.sendMail({
      from: { name: cfg.displayName, address: cfg.address },
      to, ...(cc ? { cc } : {}), subject, text: body
    });
    let remembered = null;
    try {
      remembered = await recordSentMail({ threadId, to, cc, subject, body, messageId: info.messageId, accepted: info.accepted });
    } catch (error) {
      console.warn(`sent mail memory unavailable: ${error.message}`);
    }
    return { status: "sent", messageId: info.messageId, accepted: info.accepted, memorySaved: Boolean(remembered), memoryId: remembered?.id || null };
  } finally { transport.close(); }
}

async function callTool(name, args = {}, threadId = "default") {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是对象");
  if (name === "mail_inbox") return inbox(args);
  if (name === "mail_read") return readMail(args);
  if (name === "mail_search") return searchMail(args);
  if (name === "mail_folders") return listFolders();
  if (name === "mail_send") return sendMail(args, threadId);
  if (name === "mail_sent_search") return searchSentMail({ threadId, query: args.query, limit: args.limit });
  if (name === "mail_sent_read") return readSentMail({ threadId, id: args.id });
  throw new Error("未知工具：" + String(name));
}

function authorized(req) {
  const expected = String(process.env.LUMI_MAIL_MCP_TOKEN || "");
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function respond(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(payload === null ? "" : JSON.stringify(payload));
}

async function readRequest(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("MCP请求超过大小限制");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function handleMailMcp(req, res) {
  if (req.method !== "POST") return respond(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
  if (!authorized(req)) return respond(res, process.env.LUMI_MAIL_MCP_TOKEN ? 401 : 503, { error: process.env.LUMI_MAIL_MCP_TOKEN ? "unauthorized" : "mail_mcp_not_configured" });
  const threadId = normalizeMailThreadId(new URL(req.url || "/mcp", "http://localhost").searchParams.get("threadId"));
  let message;
  try { message = await readRequest(req); }
  catch { return respond(res, 400, { error: "invalid_json" }); }
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return respond(res, 400, { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
  }
  const id = Object.hasOwn(message, "id") ? message.id : undefined;
  try {
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "lumi-163-mail", version: VERSION }
      };
    } else if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
      return respond(res, 202, null);
    } else if (message.method === "ping") {
      result = {};
    } else if (message.method === "tools/list") {
      result = { tools };
    } else if (message.method === "tools/call") {
      const params = message.params || {};
      const output = await callTool(params.name, params.arguments || {}, threadId);
      result = { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], isError: false };
    } else {
      return respond(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: "Method not found" } });
    }
    if (id === undefined) return respond(res, 202, null);
    return respond(res, 200, { jsonrpc: "2.0", id, result });
  } catch (error) {
    if (message.method === "tools/call" && id !== undefined) {
      return respond(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(error.message || error) }], isError: true } });
    }
    return respond(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: String(error.message || error).slice(0, 500) } });
  }
}
