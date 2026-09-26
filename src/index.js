import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, createPrivateKey, createSign, randomUUID, timingSafeEqual } from "node:crypto";
import { connect } from "node:http2";
import { createServer } from "node:http";

const port = Number(process.env.PORT || 8787);
const dataDir = process.env.LUMI_DATA_DIR || join(process.cwd(), "data");
const threadPath = join(dataDir, "threads.json");
const cacheStatsPath = join(dataDir, "cache-stats.json");
const proactiveSettingsPath = join(dataDir, "proactive-settings.json");
const pushTokensPath = join(dataDir, "push-tokens.json");
const contextLimit = Number(process.env.LUMI_CONTEXT_LIMIT || 200000);
const compactAtTokens = Math.min(Number(process.env.LUMI_COMPACT_AT_TOKENS || 100000), Math.floor(contextLimit * 0.85));
const tailTokens = Number(process.env.LUMI_COMPACT_TAIL_TOKENS || 20000);
const memoryAPI = (process.env.LUMI_MEMORY_API_URL || "https://memorycore.zeabur.app").replace(/\/$/, "");
const memorySearchPath = process.env.LUMI_MEMORY_SEARCH_PATH || "/api/search";
const memoryWritePath = process.env.LUMI_MEMORY_WRITE_PATH || "/api/integrations/nook/memories";
const memoryCacheTTL = Number(process.env.LUMI_MEMORY_CACHE_TTL_MS || 300000);
const memorySearchCache = new Map();
const promptCacheEnabled = process.env.LUMI_PROMPT_CACHE_ENABLED !== "false";
const cacheTTL = process.env.LUMI_PROMPT_CACHE_TTL || "1h";
const keepaliveEnabled = process.env.LUMI_CACHE_KEEPALIVE_ENABLED === "true";
const keepaliveIntervalMs = cacheTTL === "1h" ? 45 * 60_000 : 4 * 60_000;
const keepaliveMaxIdleMs = Number(process.env.LUMI_CACHE_KEEPALIVE_MAX_IDLE_MS || (cacheTTL === "1h" ? 24 * 60 * 60_000 : 12 * 60_000));
const keepaliveState = { lastRequestAt: 0, lastThreadId: "", disabledForMessageId: "", attempts: 0, successes: 0, readTokens: 0, writeTokens: 0, lastReadTokens: 0, lastWriteTokens: 0, lastAt: null, lastError: "" };
let keepaliveInFlight = false;
const cacheStats = { modelCalls: 0, cacheReadTokens: 0, cacheWriteTokens: 0, memorySearches: 0, memoryCacheHits: 0, memoryResults: 0, memoryLastError: "", lastUsage: {} };
const proactiveSettings = { enabled: false, threadId: "default", message: "有一段时间没聊了，结合我们的上下文自然地来找我说句话。", intervalMin: 60, intervalMax: 60, nextDueAt: null, scheduledForUserMessageId: null, lastNudgedForUserMessageId: null };
let proactiveCheckInFlight = false;
let pushTokens = [];
let apnsJwtCache = { token: "", createdAt: 0 };
const activeChatThreads = new Set();
const recentMessageRequests = new Map();
// Older iOS builds may retry a timed-out POST more than a minute later.
// Keep exact-body results long enough to cover their three attempts.
const legacyRetryWindowMs = 3 * 60_000;
let memoryCookie = "";

const seed = () => ({
  id: "default",
  title: "沈屿",
  messages: [{ id: randomUUID(), role: "assistant", content: "下午的风很轻，想和你说说话。", createdAt: new Date().toISOString() }]
});

async function readThreads() {
  await mkdir(dataDir, { recursive: true });
  try { return JSON.parse(await readFile(threadPath, "utf8")); }
  catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`thread history preserved; failed to read ${threadPath}: ${error.message}`);
      throw new Error("聊天历史文件读取失败，原文件已保留，避免覆盖历史记录");
    }
    const initial = { default: seed() };
    await saveThreads(initial);
    return initial;
  }
}

async function saveThreads(threads) {
  await mkdir(dataDir, { recursive: true });
  const temporaryPath = `${threadPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(threads, null, 2));
  await rename(temporaryPath, threadPath);
}

async function loadCacheStats() {
  await mkdir(dataDir, { recursive: true });
  try {
    const saved = JSON.parse(await readFile(cacheStatsPath, "utf8"));
    for (const key of ["modelCalls", "cacheReadTokens", "cacheWriteTokens", "memorySearches", "memoryCacheHits", "memoryResults"]) {
      const value = Number(saved[key]);
      if (Number.isFinite(value) && value >= 0) cacheStats[key] = value;
    }
    if (typeof saved.memoryLastError === "string") cacheStats.memoryLastError = saved.memoryLastError;
    if (saved.lastUsage && typeof saved.lastUsage === "object") cacheStats.lastUsage = saved.lastUsage;
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`cache stats unavailable: ${error.message}`);
  }
}

async function saveCacheStats() {
  const temporaryPath = `${cacheStatsPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(cacheStats));
  await rename(temporaryPath, cacheStatsPath);
}

async function loadProactiveSettings() {
  await mkdir(dataDir, { recursive: true });
  try { Object.assign(proactiveSettings, JSON.parse(await readFile(proactiveSettingsPath, "utf8"))); }
  catch (error) { if (error?.code !== "ENOENT") console.warn(`proactive settings unavailable: ${error.message}`); }
}

async function saveProactiveSettings() {
  const temporaryPath = `${proactiveSettingsPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(proactiveSettings, null, 2));
  await rename(temporaryPath, proactiveSettingsPath);
}

async function loadPushTokens() {
  await mkdir(dataDir, { recursive: true });
  try {
    const saved = JSON.parse(await readFile(pushTokensPath, "utf8"));
    pushTokens = Array.isArray(saved) ? saved.filter((item) => item && typeof item.token === "string") : [];
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`push tokens unavailable: ${error.message}`);
  }
}

async function savePushTokens() {
  const temporaryPath = `${pushTokensPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(pushTokens, null, 2));
  await rename(temporaryPath, pushTokensPath);
}

function apnsConfigured() {
  return Boolean(process.env.LUMI_APNS_KEY_ID && process.env.LUMI_APNS_TEAM_ID && process.env.LUMI_APNS_PRIVATE_KEY_BASE64);
}

function pushRequestAuthorized(req) {
  const expected = String(process.env.LUMI_PUSH_API_TOKEN || "");
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function apnsBearerToken() {
  if (!apnsConfigured()) throw new Error("APNs credentials are not configured");
  if (apnsJwtCache.token && Date.now() - apnsJwtCache.createdAt < 45 * 60_000) return apnsJwtCache.token;
  const key = createPrivateKey(Buffer.from(process.env.LUMI_APNS_PRIVATE_KEY_BASE64.replace(/\s/g, ""), "base64"));
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: process.env.LUMI_APNS_KEY_ID })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: process.env.LUMI_APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })).toString("base64url");
  const unsigned = `${header}.${claims}`;
  const signer = createSign("sha256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  apnsJwtCache = { token: `${unsigned}.${signature}`, createdAt: Date.now() };
  return apnsJwtCache.token;
}

async function sendAPNs(device, message) {
  const host = device.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const bearer = apnsBearerToken();
  const client = connect(host);
  return await new Promise((resolve, reject) => {
    let status = 0;
    let responseBody = "";
    const timeout = setTimeout(() => client.destroy(new Error("APNs request timed out")), 12000);
    client.on("error", (error) => { clearTimeout(timeout); reject(error); });
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${device.token}`,
      authorization: `bearer ${bearer}`,
      "apns-topic": process.env.LUMI_APNS_TOPIC || "com.cai5232.LumiPush",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json"
    });
    request.on("response", (headers) => { status = Number(headers[":status"] || 0); });
    request.on("data", (chunk) => { responseBody += chunk; });
    request.on("end", () => {
      clearTimeout(timeout);
      client.close();
      resolve({ status, body: responseBody });
    });
    request.on("error", (error) => { clearTimeout(timeout); client.destroy(); reject(error); });
    request.end(JSON.stringify({ aps: { alert: { title: "沈屿", body: String(message || "有一条新消息").replace(/<[^>]*>/g, "").slice(0, 220) }, sound: "default" } }));
  });
}

async function sendProactivePush(threadId, message) {
  if (!apnsConfigured()) { console.warn("proactive push skipped: APNs credentials are not configured"); return; }
  const targets = pushTokens.filter((item) => item.threadId === threadId);
  for (const device of targets) {
    try {
      const result = await sendAPNs(device, message);
      if (result.status < 200 || result.status >= 300) {
        console.warn(`APNs delivery failed (${result.status}): ${result.body}`);
        if (result.status === 410 || /BadDeviceToken|Unregistered/.test(result.body)) {
          pushTokens = pushTokens.filter((item) => item.token !== device.token);
          await savePushTokens();
        }
      }
    } catch (error) { console.warn(`APNs delivery failed: ${error.message}`); }
  }
}

function chooseNudgeIntervalMs() {
  const min = Math.max(10, Number(proactiveSettings.intervalMin) || 60);
  const max = Math.max(min, Number(proactiveSettings.intervalMax) || min);
  return (min + Math.random() * (max - min)) * 60_000;
}

async function checkProactiveNudge() {
  if (proactiveCheckInFlight || !proactiveSettings.enabled || !String(proactiveSettings.message || "").trim()) return;
  // Never charge for an unsolicited message unless a valid push destination is ready.
  if (!apnsConfigured() || !pushTokens.some((device) => device.threadId === (proactiveSettings.threadId || "default"))) return;
  proactiveCheckInFlight = true;
  try {
    const threads = await readThreads();
    const threadId = proactiveSettings.threadId || "default";
    const thread = threads[threadId];
    if (!thread || activeChatThreads.has(threadId)) return;
    const messages = thread.messages || [];
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    if (proactiveSettings.lastNudgedForUserMessageId === lastUser.id) return;
    if (proactiveSettings.scheduledForUserMessageId !== lastUser.id || !proactiveSettings.nextDueAt) {
      proactiveSettings.scheduledForUserMessageId = lastUser.id;
      proactiveSettings.nextDueAt = new Date(new Date(lastUser.createdAt).getTime() + chooseNudgeIntervalMs()).toISOString();
      await saveProactiveSettings();
      return;
    }
    if (Date.now() < new Date(proactiveSettings.nextDueAt).getTime()) return;

    // Reserve this user turn before calling the model so a restart cannot charge twice.
    proactiveSettings.lastNudgedForUserMessageId = lastUser.id;
    proactiveSettings.scheduledForUserMessageId = null;
    proactiveSettings.nextDueAt = null;
    await saveProactiveSettings();
    const input = `[nudge] ${String(proactiveSettings.message).trim()}`;
    const generated = await generateReply({ input, systemPrompt: "", thread, proactive: true });
    const now = new Date().toISOString();
    thread.messages.push({ id: randomUUID(), role: "assistant", content: generated.content, createdAt: new Date().toISOString() });
    await saveThreads(threads);
    proactiveSettings.scheduledForUserMessageId = lastUser.id;
    await saveProactiveSettings();
    console.log(`proactive nudge saved for chat ${threadId}`);
    await sendProactivePush(threadId, generated.content);
  } catch (error) {
    console.warn(`proactive nudge skipped: ${error.message}`);
    // Leave it disabled after a failed trigger; do not loop into repeated paid attempts.
    proactiveSettings.enabled = false;
    await saveProactiveSettings().catch(() => {});
  } finally { proactiveCheckInFlight = false; }
}

function estimateTokens(text) {
  const value = String(text || "");
  const cjkCharacters = (value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  return cjkCharacters + Math.ceil((value.length - cjkCharacters) / 4);
}
function estimateCacheTokens(text) { return estimateTokens(text); }
function isHTMLContent(content) {
  const source = String(content || "").trim().replace(/^```(?:html|xml)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (/^(?:<!doctype\s+html\b|<(?:html|svg)\b)/i.test(source)) return true;
  const tags = "html|head|body|title|meta|link|div|span|p|a|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|svg|path|iframe|section|article|main|header|footer|nav|button|input|textarea|label|form|select|option|canvas|video|audio|pre|code|blockquote|br|hr|style|script|details|summary";
  const tagPattern = new RegExp(`<\\/?(?:${tags})\\b[^>]*>`, "gi");
  const matches = source.match(tagPattern) || [];
  return matches.length >= 2 && new RegExp(`</(?:${tags})\\s*>`, "i").test(source);
}
function extractHTMLBlock(content, preferredTitle = "") {
  const source = String(content || "").trim();
  const titled = String(preferredTitle || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const titleFrom = (html) => {
    const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i) || html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
    const inferred = match?.[1]?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return (titled || inferred || "AI 生成页面").slice(0, 64);
  };
  const fencePattern = /```(?:html|htm|xml)?[ \t]*\r?\n([\s\S]*?)```/gi;
  for (const match of source.matchAll(fencePattern)) {
    const html = match[1].trim();
    if (!isHTMLContent(html)) continue;
    const start = match.index ?? 0;
    return { content: `${source.slice(0, start)} ${source.slice(start + match[0].length)}`.trim(), htmlContent: html, htmlTitle: titleFrom(html) };
  }
  const startMatch = /<!doctype\s+html\b|<(?:html|svg|main|section|article|div|table|form|button)\b/i.exec(source);
  if (!startMatch) return null;
  const start = startMatch.index;
  const tail = source.slice(start);
  const root = /^<(?:!doctype\s+html\b[^>]*>\s*)?<([a-z][a-z0-9:-]*)\b[^>]*>/i.exec(tail)?.[1];
  if (!root) return null;
  const closeTag = new RegExp(`</${root}\\s*>`, "ig");
  let lastClose;
  for (const match of tail.matchAll(closeTag)) lastClose = match;
  if (!lastClose) return null;
  const end = (lastClose.index ?? 0) + lastClose[0].length;
  const htmlContent = tail.slice(0, end).trim();
  if (!isHTMLContent(htmlContent)) return null;
  return { content: `${source.slice(0, start)} ${source.slice(start + end)}`.trim(), htmlContent, htmlTitle: titleFrom(htmlContent) };
}
function contextMessages(thread) {
  const messages = thread.messages || [];
  const boundaryId = thread.compactedThroughMessageId;
  if (!boundaryId) return messages;
  const boundaryIndex = messages.findIndex((message) => message.id === boundaryId);
  return boundaryIndex >= 0 ? messages.slice(boundaryIndex + 1) : messages;
}
function messageTokens(messages) { return messages.reduce((total, message) => total + estimateTokens(message.modelContent || message.content) + 8, 0); }

async function callModel({ messages, temperature = 0.8, maxOutputTokens, cacheCurrentUser = true }) {
  const configuredURL = process.env.LUMI_MODEL_API_URL;
  const apiKey = process.env.LUMI_MODEL_API_KEY;
  const model = process.env.LUMI_MODEL_NAME;
  if (!configuredURL || !apiKey || !model) {
    throw new Error("模型服务尚未配置：请在 Zeabur 设置 LUMI_MODEL_API_URL、LUMI_MODEL_API_KEY、LUMI_MODEL_NAME");
  }
  const isClaude = /anthropic|claude/i.test(model);
  const nativeAnthropic = isClaude && process.env.LUMI_NATIVE_ANTHROPIC === "true";
  const apiURL = nativeAnthropic && /\/api\/v1\/?$/i.test(configuredURL)
    ? configuredURL.replace(/\/api\/v1\/?$/i, "/api/anthropic/v1/messages")
    : /\/chat\/completions\/?$/i.test(configuredURL)
    ? configuredURL
    : `${configuredURL.replace(/\/$/, "")}/chat/completions`;

  const providerMessages = messages.map((message) => {
    const { images = [], ...cleanMessage } = message;
    if (message.role !== "user" || !Array.isArray(images) || !images.length) return cleanMessage;
    const imageBlocks = images.map((image) => {
      const match = String(image).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/i);
      if (!match) return null;
      return nativeAnthropic
        ? { type: "image", source: { type: "base64", media_type: match[1].toLowerCase(), data: match[2] } }
        : { type: "image_url", image_url: { url: image } };
    }).filter(Boolean);
    return { ...cleanMessage, content: [{ type: "text", text: String(message.content || "请识别这张图片。") }, ...imageBlocks] };
  });
  const preparedMessages = cacheMessages(providerMessages, model, cacheCurrentUser);
  const requestBody = nativeAnthropic
    ? {
        model: process.env.LUMI_NATIVE_ANTHROPIC_MODEL || zenmuxAnthropicModel(model),
        max_tokens: Number(maxOutputTokens || process.env.LUMI_MAX_OUTPUT_TOKENS || 8192),
        system: preparedMessages.filter((message) => message.role === "system").flatMap((message) => Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content || "") }]),
        messages: preparedMessages.filter((message) => message.role !== "system")
      }
    : { model, messages: preparedMessages, temperature, ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}) };

  const response = await fetch(apiURL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(nativeAnthropic ? { "anthropic-version": "2023-06-01" } : {})
    },
    body: JSON.stringify(requestBody)
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw }; }
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `模型服务返回 ${response.status}`);
  cacheStats.modelCalls += 1;
  const usage = data?.usage || {};
  cacheStats.lastUsage = usage;
  cacheStats.cacheReadTokens += Number(usage?.prompt_tokens_details?.cached_tokens || usage?.cache_read_input_tokens || 0);
  cacheStats.cacheWriteTokens += Number(usage?.cache_creation_input_tokens || usage?.prompt_tokens_details?.cache_creation_input_tokens || 0);
  await saveCacheStats().catch((error) => console.warn(`cache stats save skipped: ${error.message}`));
  const content = nativeAnthropic
    ? data?.content?.filter((block) => block.type === "text").map((block) => block.text).join("")
    : data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("模型没有返回内容");
  return content.trim();
}

function zenmuxAnthropicModel(model) {
  const normalized = String(model).replace(/^anthropic\//i, "");
  // ZenMux recommends dashed Claude aliases on its native Anthropic route.
  if (normalized === "claude-sonnet-4.6") return "claude-sonnet-4-6";
  if (normalized === "claude-sonnet-4.5") return "claude-sonnet-4-5";
  return normalized;
}

function cacheMessages(messages, model, cacheCurrentUser = true) {
  if (!promptCacheEnabled || !/anthropic|claude/i.test(String(model))) return messages;
  const cloned = messages.map((message) => ({ ...message }));
  const firstSystem = cloned.findIndex((message) => message.role === "system");
  if (firstSystem >= 0 && estimateCacheTokens(cloned[firstSystem].content) >= 1024) {
    cloned[firstSystem] = { ...cloned[firstSystem], content: [{ type: "text", text: cloned[firstSystem].content, cache_control: { type: "ephemeral", ttl: cacheTTL } }] };
  }
  const lastUser = cloned.map((message) => message.role).lastIndexOf("user");
  const cacheBoundary = lastUser > 0 ? cloned.slice(0, lastUser).map((message) => message.role).lastIndexOf("user") : -1;
  const prefixTokens = cacheBoundary >= 0
    ? cloned.slice(0, cacheBoundary + 1).reduce((total, message) => total + estimateCacheTokens(typeof message.content === "string" ? message.content : JSON.stringify(message.content)), 0)
    : 0;
  // Anthropic's minimum applies to the entire cached prefix, not to this one
  // message. Short chat turns still need a breakpoint so the growing history
  // can be read from cache on the next request.
  if (cacheBoundary >= 0 && typeof cloned[cacheBoundary].content === "string" && prefixTokens >= 1024) {
    cloned[cacheBoundary] = { ...cloned[cacheBoundary], content: [{ type: "text", text: cloned[cacheBoundary].content, cache_control: { type: "ephemeral", ttl: cacheTTL } }] };
  }
  // A keepalive writes the most recent assistant reply into the cache. The next
  // real chat must mark that same block to read the extended prefix directly.
  const lastAssistant = cloned.slice(0, lastUser).map((message) => message.role).lastIndexOf("assistant");
  if (lastAssistant >= 0 && typeof cloned[lastAssistant].content === "string") {
    const assistantPrefixTokens = cloned.slice(0, lastAssistant + 1).reduce((total, message) =>
      total + estimateCacheTokens(typeof message.content === "string" ? message.content : JSON.stringify(message.content)), 0);
    if (assistantPrefixTokens >= 1024) {
      cloned[lastAssistant] = { ...cloned[lastAssistant], content: [{ type: "text", text: cloned[lastAssistant].content, cache_control: { type: "ephemeral", ttl: cacheTTL } }] };
    }
  }
  // Write the current request's stable prefix now. On the next turn the same
  // user block is present in history, so even the second turn can read it.
  // Images are intentionally excluded: their data is not persisted in history.
  if (cacheCurrentUser && lastUser >= 0 && typeof cloned[lastUser].content === "string") {
    const currentPrefixTokens = cloned.slice(0, lastUser + 1).reduce((total, message) =>
      total + estimateCacheTokens(typeof message.content === "string" ? message.content : JSON.stringify(message.content)), 0);
    if (currentPrefixTokens >= 1024) {
      cloned[lastUser] = { ...cloned[lastUser], content: [{ type: "text", text: cloned[lastUser].content, cache_control: { type: "ephemeral", ttl: cacheTTL } }] };
    }
  }
  return cloned;
}

async function memoryHeaders(contentType = true) {
  const headers = contentType ? { "content-type": "application/json" } : {};
  if (process.env.LUMI_MEMORY_API_KEY) headers.authorization = `Bearer ${process.env.LUMI_MEMORY_API_KEY}`;
  if (!process.env.LUMI_MEMORY_API_KEY && process.env.LUMI_MEMORY_PASSWORD && !memoryCookie) {
    const login = await fetch(`${memoryAPI}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: process.env.LUMI_MEMORY_PASSWORD }),
      signal: AbortSignal.timeout(4000)
    });
    const cookie = login.headers.get("set-cookie");
    if (login.ok && cookie) memoryCookie = cookie.split(";")[0];
  }
  if (memoryCookie) headers.cookie = memoryCookie;
  return headers;
}

async function memoryRequest(path, payload) {
  const headers = await memoryHeaders();
  const response = await fetch(`${memoryAPI}${path.startsWith("/") ? path : `/${path}`}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(4000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `记忆库返回 ${response.status}`);
  return data;
}

async function memorySearchRequest(query) {
  const cacheKey = String(query).trim().toLowerCase();
  const cached = memorySearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) { cacheStats.memoryCacheHits += 1; await saveCacheStats().catch(() => {}); return cached.data; }
  if (cached) memorySearchCache.delete(cacheKey);
  const headers = await memoryHeaders(false);
  cacheStats.memorySearches += 1;
  await saveCacheStats().catch(() => {});
  const response = await fetch(`${memoryAPI}${memorySearchPath}?q=${encodeURIComponent(query)}`, {
    headers,
    signal: AbortSignal.timeout(4000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `记忆库返回 ${response.status}`);
  memorySearchCache.set(cacheKey, { data, expiresAt: Date.now() + memoryCacheTTL });
  return data;
}

function fallbackKeywords(input) {
  return [...new Set(String(input).split(/[^\p{L}\p{N}]+/u).map((part) => part.trim()).filter((part) => part.length > 1))].slice(0, 8);
}

function extractMemoryKeywords(input) { return fallbackKeywords(input); }

function normalizeMemories(data) {
  const container = data?.data && !Array.isArray(data.data) ? data.data : data;
  const list = Array.isArray(data) ? data : container.memories || container.results || container.items || container.data || [];
  return list.map((item) => {
    if (typeof item === "string") return item;
    return item.content || item.text || item.memory || item.value || item.summary || item.content_preview || "";
  }).filter(Boolean).slice(0, 8);
}

async function searchMemories(input) {
  const keywords = await extractMemoryKeywords(input);
  const source = String(input || "").trim().slice(0, 1200);
  if (!source) return [];
  const query = [source, ...keywords].filter(Boolean).join(" ");
  try {
    const memories = normalizeMemories(await memorySearchRequest(query));
    cacheStats.memoryResults += memories.length;
    cacheStats.memoryLastError = "";
    await saveCacheStats().catch(() => {});
    return memories;
  } catch (error) {
    cacheStats.memoryLastError = (error.message || String(error)).slice(0, 240);
    console.warn(`memory search skipped: ${cacheStats.memoryLastError}`);
    await saveCacheStats().catch(() => {});
    return [];
  }
}

async function writeMemory(content, threadId) {
  try {
    const created = await memoryRequest(memoryWritePath, {
      dream_line: content,
      content,
      memory: content,
      text: content,
      status: "draft",
      note_type: "inward",
      drive_tag: "lumi",
      source: "lumi",
      threadId
    });
    const id = created?.id || created?.note?.id || created?.data?.id;
    if (id && memoryWritePath.includes("/api/latent-notes")) {
      await memoryRequest(`${memoryWritePath}/${encodeURIComponent(id)}/update`, { status: "approved" });
    }
    memorySearchCache.clear();
    return true;
  } catch (error) { console.warn(`memory write skipped: ${error.message}`); return false; }
}

async function compactThread(thread, pendingInput = "") {
  const messages = contextMessages(thread);
  const pendingTokens = pendingInput ? estimateTokens(pendingInput) + 8 : 0;
  if (messageTokens(messages) + pendingTokens < compactAtTokens) return false;

  // Preserve whole user/assistant turns in the recent cache-friendly tail.
  let tail = [];
  let tailCount = 0;
  for (let index = messages.length - 1; index >= 0;) {
    let start = index;
    if (messages[index].role === "assistant" && index > 0 && messages[index - 1].role === "user") start = index - 1;
    const turn = messages.slice(start, index + 1);
    const cost = messageTokens(turn);
    if (tail.length && tailCount + cost > tailTokens) break;
    tail.unshift(...turn);
    tailCount += cost;
    index = start - 1;
  }
  const older = messages.slice(0, Math.max(0, messages.length - tail.length));
  if (!older.length) return false;
  const previous = thread.contextSummary ? `已有摘要：\n${thread.contextSummary}\n\n` : "";
  const prompt = `${previous}请把下面的聊天历史压缩成长期上下文摘要。保留用户画像、关系变化、已确认事实和当前未完成事项；用具体内容填充每个字段，不要复述字段说明。只输出 XML，不要解释：\n<context_summary>\n  <user_profile>称呼、偏好、语言习惯与长期信息</user_profile>\n  <relationship_dynamic>关系背景、相处氛围与角色状态</relationship_dynamic>\n  <key_decisions_and_facts>确认过的事实、约定、重要事件</key_decisions_and_facts>\n  <active_topics_and_todos>当前话题、未完成事项与下一步</active_topics_and_todos>\n</context_summary>\n聊天历史：\n${older.map((message) => `${message.role}: ${message.content}`).join("\n")}`;
  thread.contextSummary = await callModel({
    messages: [
      { role: "system", content: "你是上下文压缩器。保持事实，不编造，不输出聊天回复。" },
      { role: "user", content: prompt }
    ],
    temperature: 0.2,
    maxOutputTokens: Number(process.env.LUMI_COMPACT_SUMMARY_TOKENS || 25000)
  });
  thread.compactionCount = (thread.compactionCount || 0) + 1;
  thread.compactedAt = new Date().toISOString();
  thread.compactedThroughMessageId = older[older.length - 1].id;
  return true;
}

function chooseEmojiFromMood(mood, faces, reply) {
  const candidates = [...new Set(faces.filter((face) => typeof face === "string").map((face) => face.trim()).filter(Boolean))].slice(0, 40);
  if (!candidates.length) return "";
  // The main reply already selected the mood. Pick a face locally instead of
  // paying for another uncached Sonnet call on every emoji-bearing reply.
  let index = 0;
  for (const character of `${mood}:${reply.slice(-120)}`) index = (index * 31 + character.codePointAt(0)) >>> 0;
  return candidates[index % candidates.length];
}

function spokenReply(content) {
  return String(content)
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/[（(][^（）()\n]{0,80}[）)]/g, "")
    .replace(/\[(?:左耳|右耳|脑后|面前|贴近|退开)\]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\/\\／＼~～^＿_]+[ωwW]+[\/\\／＼~～^＿_]+/g, "")
    .replace(/[\/\\／＼~～^＿_]{2,}/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((spoken, line) => spoken ? `${spoken}${/[。！？!?，,；;：:]$/.test(spoken) ? "" : "，"}${line}` : line, "")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutSpeechPlanning(content) {
  return String(content).replace(/<thinking>([\s\S]*?)<\/thinking>/gi, (_, thought) => {
    const cleaned = String(thought)
      .replace(/(?:^|(?<=[。！？!?]))[^。！？!?]*\bspeech_enabled\b[^。！？!?]*[。！？!?]?/gi, "")
      .trim();
    return cleaned ? `<thinking>${cleaned}</thinking>` : "";
  });
}

async function generateReply({ input, images = [], emojiCatalog = {}, allowSpeech = false, systemPrompt, thread, proactive = false }) {
  if (!proactive) await compactThread(thread, input);
  const configuredSystem = proactive
    ? process.env.LUMI_NUDGE_SYSTEM_PROMPT || "你是沈屿，在和言言延续一段熟悉、亲近的聊天。根据最近几条对话，自然地发一条简短、不催促的消息；不要复述整段历史，也不要提及你是定时任务。"
    : process.env.LUMI_SYSTEM_PROMPT || systemPrompt || "使用中文回复。";
  const system = configuredSystem
    .replace(/日常聊天需要带动态描写与发言说话分行[^\n]*/g, "")
    .replace(/你最喜欢最像你自己最常用的颜文字[^\n]*/g, "")
    .trim();
  const summaryText = proactive ? String(thread.contextSummary || "").slice(-4000) : thread.contextSummary;
  const summary = summaryText ? `<context_summary source="system">\n${summaryText}\n</context_summary>` : "";
  const memories = await searchMemories(input);
  const timestamp = new Date().toISOString();
  const retrieved = memories.length
    ? `<retrieved_memories source="system" retrieved_at="${timestamp}">\n${memories.map((memory) => `- ${memory}`).join("\n")}\n</retrieved_memories>`
    : "";
  const relevantMessages = contextMessages(thread);
  const history = (proactive ? relevantMessages.slice(-8) : relevantMessages).map((message) => ({
    role: message.role,
    // Reuse the exact text sent on the original turn. Otherwise its timestamp/memories vanish
    // from history and the previous request's Anthropic cache prefix can never match again.
    content: message.modelContent || (message.imageAttachmentCount ? `${message.content}\n[系统记录：用户附带了${message.imageAttachmentCount}张图片]` : message.content)
  }));
  const emojiMoods = Object.entries(emojiCatalog || {}).filter(([mood, values]) => typeof mood === "string" && mood.trim() && Array.isArray(values) && values.some((value) => typeof value === "string" && value.trim())).map(([mood]) => mood).slice(0, 40);
  const systemContext = `<system_context timestamp="${timestamp}">\n当前时间（由系统发送）：${timestamp}\n<speech_enabled>${allowSpeech}</speech_enabled>${summary ? `\n${summary}` : ""}${retrieved ? `\n${retrieved}` : ""}${emojiMoods.length ? `\n<available_emoji_moods>${emojiMoods.join("、")}</available_emoji_moods>` : ""}\n</system_context>`;
  const userModelContent = `${systemContext}\n\n${input}`;
  const cacheSystem = `${system}\n\n你可以自行决定要不要使用颜文字，不必每条都用。若决定使用用户的颜文字库，只在回复末尾输出 <emoji_mood>一个可用心情标签</emoji_mood>；没有决定使用就不要输出此标签。系统随后只读取这个心情里的颜文字，标签不要展示给用户。你可以使用标签添加记忆，自行判断这需不需要记录下这一刻，不要太频繁也不要一点不记。需要记忆时仅在回复末尾添加 <memory>要记住的原文</memory>，不要向用户解释这个标签。仅当本轮 <speech_enabled>true</speech_enabled> 时，你可以自主判断是否值得发一条语音，不要每条都配语音；决定使用时才在回复最后附加 <speech>单独要朗读的一句话</speech>。这句话必须和正文不同，不得复述或改写正文；不要使用颜文字、emoji、动作描写、位置提示、换行或任何标签。如果本轮标记为 false，禁止输出 speech 标签。普通文字回复始终照常显示，语音标签只供系统生成音频，绝不能把标签展示给用户。thinking 中不要讨论 speech_enabled、语音开关或是否发语音。`;
  const cacheRequestMessages = [
    { role: "system", content: cacheSystem },
    ...history,
    // Keep request-specific context (timestamp, retrieved memories, rolling summary) in the
    // uncached suffix. Putting it in `system` changes Anthropic's system prefix every turn and
    // invalidates the message-cache prefix even when all earlier chat turns are unchanged.
    { role: "user", content: userModelContent, images }
  ];
  const cacheRequestStartedAt = Date.now();
  const raw = await callModel({
    maxOutputTokens: proactive ? 256 : undefined,
    messages: cacheRequestMessages
  });
  const cleanedRaw = withoutSpeechPlanning(raw);
  const memoryMatch = cleanedRaw.match(/<memory>([\s\S]*?)<\/memory>/i);
  const speechMatch = allowSpeech ? cleanedRaw.match(/<speech>([\s\S]*?)<\/speech>/i) : null;
  const emojiMood = cleanedRaw.match(/<emoji_mood>([\s\S]*?)<\/emoji_mood>/i)?.[1]?.trim() || "";
  const memoryContent = memoryMatch?.[1]?.trim();
  const titleMatch = cleanedRaw.match(/<html_title>([\s\S]*?)<\/html_title>/i);
  let content = cleanedRaw.replace(/<memory>[\s\S]*?<\/memory>/gi, "").replace(/<speech>[\s\S]*?<\/speech>/gi, "").replace(/<emoji_mood>[\s\S]*?<\/emoji_mood>/gi, "").replace(/<html_title>[\s\S]*?<\/html_title>/gi, "").trim();
  if (emojiMoods.includes(emojiMood) && !isHTMLContent(content)) {
    const chosen = chooseEmojiFromMood(emojiMood, emojiCatalog[emojiMood], content);
    if (chosen) content = `${content} ${chosen}`;
  }
  const htmlBlock = extractHTMLBlock(content, titleMatch?.[1]);
  if (htmlBlock) content = htmlBlock.content;
  const memorySaved = memoryContent ? await writeMemory(memoryContent, thread.id) : false;
  const speechText = speechMatch ? spokenReply(speechMatch[1]) : "";
  // Preserve the exact provider text for the next request's cache prefix. The
  // user-visible content is intentionally cleaned separately below.
  // Snapshot the exact request prefix used for this chat turn. Keepalive replays
  // this snapshot instead of reconstructing messages from stored display history.
  const cacheKeepaliveMessages = cacheRequestMessages.map(({ images: _images, ...message }) => message);
  return { content, htmlContent: htmlBlock?.htmlContent || null, htmlTitle: htmlBlock?.htmlTitle || null, memorySaved, speechText, modelContent: raw, userModelContent, cacheSystem, cacheRequestStartedAt, cacheKeepaliveMessages };
}

async function checkCacheKeepalive() {
  if (!keepaliveEnabled || !promptCacheEnabled || keepaliveInFlight || proactiveCheckInFlight ||
      !/anthropic|claude/i.test(process.env.LUMI_MODEL_NAME || "")) return { attempted: false, reason: "disabled_or_busy" };
  const id = "default";
  if (activeChatThreads.has(id)) return { attempted: false, reason: "chat_in_progress" };
  keepaliveInFlight = true;
  let lastUserMessageId = "";
  try {
    const threads = await readThreads();
    const thread = threads[id];
    if (!thread?.cacheSystem || thread.cacheModel !== process.env.LUMI_MODEL_NAME) return { attempted: false, reason: "no_matching_chat_cache" };
    const history = contextMessages(thread);
    const lastUser = [...history].reverse().find((message) => message.role === "user");
    lastUserMessageId = lastUser?.id || "";
    if (!lastUser || lastUser.imageAttachmentCount ||
        keepaliveState.disabledForMessageId === lastUser.id) return { attempted: false, reason: "latest_turn_not_eligible" };
    const lastRequestAt = Math.max(
      Number(thread.cacheRequestStartedAt || 0),
      Number(thread.cacheKeepaliveAt || 0),
      keepaliveState.lastThreadId === id ? Number(keepaliveState.lastRequestAt || 0) : 0
    );
    const lastRealAt = Math.max(Date.parse(lastUser.createdAt), lastRequestAt);
    if (!Number.isFinite(lastRealAt) || !Number.isFinite(lastRequestAt) ||
        Date.now() - lastRealAt > keepaliveMaxIdleMs) return { attempted: false, reason: "too_idle" };
    if (Date.now() - lastRequestAt < keepaliveIntervalMs) return { attempted: false, reason: "not_due" };
    const cachedRequest = Array.isArray(thread.cacheKeepaliveMessages) ? thread.cacheKeepaliveMessages : null;
    const lastAssistant = history[history.length - 1];
    if (!cachedRequest?.length || cachedRequest.at(-1)?.role !== "user" ||
        cachedRequest.at(-1)?.content !== lastUser.modelContent ||
        history.at(-2)?.id !== lastUser.id ||
        lastAssistant?.role !== "assistant" || typeof lastAssistant.modelContent !== "string") {
      return { attempted: false, reason: "no_matching_chat_snapshot" };
    }
    // The probe's suffix differs from a real user message. Both requests mark
    // the assistant block immediately before it, so they share the same prefix.
    const keepaliveMessages = [...cachedRequest,
      { role: "assistant", content: lastAssistant.modelContent },
      { role: "user", content: "[缓存保活，请简短回复。]" }];
    if (messageTokens(keepaliveMessages) < 1024) return { attempted: false, reason: "prefix_too_short" };
    const startedAt = Date.now();
    keepaliveState.attempts += 1;
    // Read the cached user prefix, then extend it through the exact assistant
    // reply that the next real chat will send as history.
    await callModel({
      messages: keepaliveMessages,
      maxOutputTokens: 16,
      temperature: 0,
      cacheCurrentUser: false
    });
    const readTokens = Number(cacheStats.lastUsage?.cache_read_input_tokens || cacheStats.lastUsage?.prompt_tokens_details?.cached_tokens || 0);
    const writeTokens = Number(cacheStats.lastUsage?.cache_creation_input_tokens || cacheStats.lastUsage?.prompt_tokens_details?.cache_creation_input_tokens || 0);
    thread.cacheKeepaliveAt = startedAt;
    await saveThreads(threads);
    keepaliveState.lastThreadId = id;
    keepaliveState.lastRequestAt = startedAt;
    keepaliveState.lastAt = new Date(startedAt).toISOString();
    keepaliveState.lastReadTokens = readTokens;
    keepaliveState.lastWriteTokens = writeTokens;
    keepaliveState.readTokens += readTokens;
    keepaliveState.writeTokens += writeTokens;
    if (readTokens > 0) {
      keepaliveState.successes += 1;
      keepaliveState.lastError = "";
      return { attempted: true, hit: true, readTokens, writeTokens };
    }
    keepaliveState.disabledForMessageId = lastUser.id;
    keepaliveState.lastError = "模型未报告缓存读取；已停止本轮保活";
    return { attempted: true, hit: false, readTokens, writeTokens };
  } catch (error) {
    if (lastUserMessageId) keepaliveState.disabledForMessageId = lastUserMessageId;
    keepaliveState.lastError = String(error.message || error).slice(0, 200);
    console.warn(`cache keepalive skipped: ${keepaliveState.lastError}`);
    return { attempted: false, reason: "error", error: keepaliveState.lastError };
  } finally { keepaliveInFlight = false; }
}

const ttsModels = ["speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo", "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo"];
async function synthesizeSpeech(text, settings) {
  if (!settings?.apiKey || !settings?.voiceID || !ttsModels.includes(settings.model)) return null;
  const minimaxHost = settings.baseURL === "https://api.minimax.io" ? settings.baseURL : "https://api.minimaxi.com";
  const response = await fetch(`${minimaxHost}/v1/t2a_v2`, {
    method: "POST",
    headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      text: String(text).replace(/\[(?:左耳|右耳|脑后|面前|贴近|退开)\]/g, "").slice(0, 9000),
      stream: false,
      voice_setting: { voice_id: settings.voiceID, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 }
    }),
    signal: AbortSignal.timeout(60000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.base_resp?.status_code) throw new Error(result?.base_resp?.status_msg || `MiniMax TTS 返回 ${response.status}`);
  const audioHex = result?.data?.audio;
  if (typeof audioHex !== "string" || !audioHex.length) throw new Error("MiniMax 没有返回音频");
  return { audioBase64: Buffer.from(audioHex, "hex").toString("base64"), duration: Number(result?.extra_info?.audio_length || 0) / 1000 };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-allow-headers": "content-type,authorization,idempotency-key" });
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
    if (url.pathname === "/v1/internal/cache-keepalive" && req.method === "POST") {
      const expected = String(process.env.LUMI_CACHE_KEEPALIVE_TOKEN || process.env.LUMI_PUSH_API_TOKEN || "");
      const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!expected || !supplied || expected.length !== supplied.length ||
          !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, await checkCacheKeepalive());
    }
    if (["/v1/settings/proactive", "/v1/push/register"].includes(url.pathname) && !pushRequestAuthorized(req)) {
      return send(res, 401, { error: "unauthorized" });
    }
    if (url.pathname === "/v1/settings/proactive" && req.method === "GET") return send(res, 200, proactiveSettings);
    if (url.pathname === "/v1/push/status" && req.method === "GET") {
      return send(res, 200, { apnsConfigured: apnsConfigured(), registeredDevices: pushTokens.length });
    }
    if (url.pathname === "/v1/push/register" && req.method === "POST") {
      const input = await body(req);
      const token = String(input.token || "").toLowerCase();
      const environment = input.environment === "sandbox" ? "sandbox" : input.environment === "production" ? "production" : "";
      if (!/^[a-f0-9]{64,256}$/.test(token) || !environment) return send(res, 400, { error: "invalid_push_token" });
      const item = { token, environment, threadId: typeof input.threadId === "string" && input.threadId ? input.threadId : "default", updatedAt: new Date().toISOString() };
      pushTokens = [item, ...pushTokens.filter((entry) => entry.token !== token)];
      await savePushTokens();
      return send(res, 200, { registered: true });
    }
    if (url.pathname === "/v1/settings/proactive" && req.method === "PUT") {
      const input = await body(req);
      if (typeof input.enabled !== "boolean") return send(res, 400, { error: "enabled_must_be_boolean" });
      const min = Number(input.intervalMin);
      const max = Number(input.intervalMax ?? min);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 10 || max < min || max > 1440) return send(res, 400, { error: "invalid_interval_minutes" });
      proactiveSettings.enabled = input.enabled;
      proactiveSettings.threadId = typeof input.threadId === "string" && input.threadId ? input.threadId : "default";
      proactiveSettings.message = typeof input.message === "string" ? input.message.slice(0, 1000) : "";
      proactiveSettings.intervalMin = min;
      proactiveSettings.intervalMax = max;
      proactiveSettings.scheduledForUserMessageId = null;
      proactiveSettings.nextDueAt = null;
      await saveProactiveSettings();
      return send(res, 200, proactiveSettings);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      const activeThread = (await readThreads()).default;
      return send(res, 200, {
      ok: true,
      htmlCards: "separate-content-title-v1",
      cache: {
      prompt: { enabled: promptCacheEnabled, model: process.env.LUMI_MODEL_NAME || "", explicitMode: /anthropic|claude/i.test(process.env.LUMI_MODEL_NAME || ""), strategy: "stable-history-v3", ttl: cacheTTL, speechFallback: "full-visible-reply-v2", modelCalls: cacheStats.modelCalls, readTokens: cacheStats.cacheReadTokens, writeTokens: cacheStats.cacheWriteTokens, hitRate: cacheStats.cacheReadTokens + cacheStats.cacheWriteTokens > 0 ? Math.round(cacheStats.cacheReadTokens / (cacheStats.cacheReadTokens + cacheStats.cacheWriteTokens) * 10000) / 100 : null, lastUsage: cacheStats.lastUsage, keepalive: { enabled: keepaliveEnabled, intervalMs: keepaliveIntervalMs, maxIdleMs: keepaliveMaxIdleMs, attempts: keepaliveState.attempts, successes: keepaliveState.successes, readTokens: keepaliveState.readTokens, writeTokens: keepaliveState.writeTokens, lastReadTokens: keepaliveState.lastReadTokens, lastWriteTokens: keepaliveState.lastWriteTokens, lastAt: keepaliveState.lastAt, lastError: keepaliveState.lastError } },
        memory: { searches: cacheStats.memorySearches, hits: cacheStats.memoryCacheHits, results: cacheStats.memoryResults, lastError: cacheStats.memoryLastError, ttlMs: memoryCacheTTL }
      },
      compaction: { count: activeThread.compactionCount || 0, lastAt: activeThread.compactedAt || null, hasSummary: Boolean(activeThread.contextSummary), activeHistoryTokensEstimate: messageTokens(contextMessages(activeThread)), triggerTokensEstimate: compactAtTokens, preservedTailTokens: tailTokens }
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/memories") {
      const input = await body(req);
      if (typeof input.content !== "string" || !input.content.trim()) return send(res, 400, { error: "content_required" });
      const saved = await writeMemory(input.content.trim(), input.threadId || "manual");
      return send(res, saved ? 201 : 502, { saved });
    }
    const match = url.pathname.match(/^\/v1\/chats\/([^/]+)(\/messages)?$/);
    if (!match) return send(res, 404, { error: "not_found" });
    const id = decodeURIComponent(match[1]);
    const threads = await readThreads();
    if (!threads[id]) threads[id] = { id, title: "新聊天", messages: [] };
    if (req.method === "GET" && !match[2]) return send(res, 200, threads[id]);
    if (req.method === "POST" && match[2]) {
      const input = await body(req);
      const images = Array.isArray(input.images) ? input.images.filter((image) => typeof image === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(image)).slice(0, 4) : [];
      if ((!input.content || !String(input.content).trim()) && !images.length) return send(res, 400, { error: "content_or_image_required" });
      const requestId = String(req.headers["idempotency-key"] || "");
      if (requestId && !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) return send(res, 400, { error: "invalid_idempotency_key" });
      if (requestId) {
        const previousIndex = threads[id].messages.findIndex((message) => message.role === "user" && message.requestId === requestId);
        if (previousIndex >= 0) {
          const userMessage = threads[id].messages[previousIndex];
          const assistantMessage = threads[id].messages[previousIndex + 1];
          if (assistantMessage?.role !== "assistant") return send(res, 409, { error: "incomplete_previous_request" });
          return send(res, 200, { userMessage, assistantMessage, memorySaved: false, speechAudioBase64: null, speechDuration: null, speechScript: null });
        }
      }
      // Older iOS builds retry the exact same POST up to three times. Coalesce
      // identical requests for a short window until those clients are updated.
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const key = `${id}:${requestId || fingerprint}`;
      for (const [storedKey, entry] of recentMessageRequests) {
        if (entry.expiresAt <= Date.now()) recentMessageRequests.delete(storedKey);
      }
      const previous = recentMessageRequests.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return send(res, 409, { error: "idempotency_key_reused" });
        return send(res, 200, await previous.result);
      }
      const result = (async () => {
      const messageText = String(input.content || "").trim();
      const userMessage = { id: randomUUID(), role: "user", content: messageText || "（发送了图片）", createdAt: new Date().toISOString() };
      const storedUserMessage = { ...userMessage, ...(images.length ? { imageAttachmentCount: images.length } : {}), ...(requestId ? { requestId } : {}) };
      let generated;
      activeChatThreads.add(id);
      try { generated = await generateReply({ input: userMessage.content, images, emojiCatalog: input.emojiCatalog, allowSpeech: Boolean(input.tts?.apiKey && input.tts?.enabled), systemPrompt: input.systemPrompt, thread: threads[id] }); }
      finally { activeChatThreads.delete(id); }
      storedUserMessage.modelContent = generated.userModelContent;
      threads[id].cacheSystem = generated.cacheSystem;
      threads[id].cacheModel = process.env.LUMI_MODEL_NAME;
      threads[id].cacheRequestStartedAt = generated.cacheRequestStartedAt;
      threads[id].cacheKeepaliveMessages = generated.cacheKeepaliveMessages;
      keepaliveState.lastThreadId = id;
      keepaliveState.lastRequestAt = generated.cacheRequestStartedAt;
      keepaliveState.disabledForMessageId = "";
      const contentType = generated.htmlContent ? (generated.content ? "mixed" : "html") : "text";
      let speech = null;
      if (input.tts?.enabled && generated.speechText && !generated.htmlContent) {
        try { speech = await synthesizeSpeech(generated.speechText, input.tts); }
        catch (error) { console.warn(`speech synthesis skipped: ${(error.message || String(error)).slice(0, 200)}`); }
      }
      const assistantMessage = {
        id: randomUUID(),
        role: "assistant",
        content: generated.content,
        // Used only when reconstructing the exact model-side history for prompt cache.
        modelContent: generated.modelContent,
        contentType,
        htmlContent: generated.htmlContent,
        htmlTitle: generated.htmlTitle,
        createdAt: new Date().toISOString()
      };
      threads[id].messages.push(storedUserMessage, assistantMessage);
      await saveThreads(threads);
      if (proactiveSettings.threadId === id) {
        proactiveSettings.scheduledForUserMessageId = userMessage.id;
        proactiveSettings.nextDueAt = new Date(Date.now() + chooseNudgeIntervalMs()).toISOString();
        await saveProactiveSettings();
      }
      return { userMessage: storedUserMessage, assistantMessage, memorySaved: generated.memorySaved, speechAudioBase64: speech?.audioBase64 || null, speechDuration: speech?.duration || null, speechScript: speech ? generated.speechText : null };
      })();
      recentMessageRequests.set(key, { fingerprint, result, expiresAt: Infinity });
      try {
        const response = await result;
        const entry = recentMessageRequests.get(key);
        if (entry?.result === result) entry.expiresAt = Date.now() + (requestId ? 5 * 60_000 : legacyRetryWindowMs);
        return send(res, 200, response);
      } catch (error) {
        if (recentMessageRequests.get(key)?.result === result) recentMessageRequests.delete(key);
        throw error;
      }
    }
    return send(res, 405, { error: "method_not_allowed" });
  } catch (error) { return send(res, 500, { error: error.message }); }
});

await loadCacheStats();
await loadProactiveSettings();
await loadPushTokens();
server.listen(port, () => console.log(`Lumi server listening on :${port}`));
setInterval(() => { void checkProactiveNudge(); }, 60_000);
setInterval(() => { void checkCacheKeepalive(); }, 60_000);
