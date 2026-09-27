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
const compactAtTokens = Math.min(Number(process.env.LUMI_COMPACT_AT_TOKENS || 68888), Math.floor(contextLimit * 0.85));
const tailTokens = Number(process.env.LUMI_COMPACT_TAIL_TOKENS || 20000);
const memoryAPI = (process.env.LUMI_MEMORY_API_URL || "https://memorycore.zeabur.app").replace(/\/$/, "");
const memorySearchPath = process.env.LUMI_MEMORY_SEARCH_PATH || "/api/search";
const memoryWritePath = process.env.LUMI_MEMORY_WRITE_PATH || "/api/integrations/nook/memories";
const memoryCacheTTL = Number(process.env.LUMI_MEMORY_CACHE_TTL_MS || 300000);
const memorySearchCache = new Map();
const promptCacheEnabled = process.env.LUMI_PROMPT_CACHE_ENABLED !== "false";
const cacheTTL = process.env.LUMI_PROMPT_CACHE_TTL || "1h";
const ttsTimeoutMs = Math.max(3_000, Number(process.env.LUMI_TTS_TIMEOUT_MS || 12_000));
const keepaliveEnabled = process.env.LUMI_CACHE_KEEPALIVE_ENABLED === "true";
const keepaliveIntervalMs = cacheTTL === "1h" ? 45 * 60_000 : 4 * 60_000;
const keepaliveMaxIdleMs = Number(process.env.LUMI_CACHE_KEEPALIVE_MAX_IDLE_MS || (cacheTTL === "1h" ? 24 * 60 * 60_000 : 12 * 60_000));
const keepaliveState = { lastRequestAt: 0, lastThreadId: "", disabledForMessageId: "", attempts: 0, successes: 0, readTokens: 0, writeTokens: 0, lastReadTokens: 0, lastWriteTokens: 0, lastAt: null, lastError: "" };
let keepaliveInFlight = false;
let keepaliveDone = Promise.resolve();
let finishKeepalive = null;
let chatRequestsInFlight = 0;
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

async function sendAPNs(device, message, metadata = null) {
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
    request.end(JSON.stringify({ aps: { alert: { title: metadata?.kind === "incoming_call" ? "沈屿来电" : "沈屿", body: String(message || "有一条新消息").replace(/<[^>]*>/g, "").slice(0, 220) }, sound: "default" }, ...(metadata || {}) }));
  });
}

async function sendProactivePush(threadId, message, metadata = null) {
  if (!apnsConfigured()) { console.warn("proactive push skipped: APNs credentials are not configured"); return; }
  const targets = pushTokens.filter((item) => item.threadId === threadId);
  for (const device of targets) {
    try {
      const result = await sendAPNs(device, message, metadata);
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

function extractDialMarker(content) {
  const source = String(content || "");
  const match = source.match(/[⟪《【\[]\s*(?:拨号|dial)\s*[:：]?\s*([^⟫》】\]]*)[⟫》】\]]/i);
  if (!match) return { content: source, reason: null };
  const reason = String(match[1] || "").trim().slice(0, 120) || "想听听你的声音";
  return {
    content: source.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim(),
    reason
  };
}

async function createIncomingCallInvite(thread, reason) {
  const now = new Date();
  const call = {
    id: randomUUID(),
    initiator: "assistant",
    state: "pending",
    reason: String(reason || "想听听你的声音").slice(0, 120),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    turns: []
  };
  thread.calls = Array.isArray(thread.calls) ? thread.calls : [];
  thread.calls.push(call);
  return call;
}

function startIncomingCallRing(threadID, call) {
  const deadline = new Date(call.expiresAt).getTime();
  const ring = async () => {
    if (Date.now() >= deadline) return;
    try {
      const threads = await readThreads();
      const current = threads[threadID]?.calls?.find((item) => item.id === call.id);
      if (!current || current.state !== "pending") return;
      await sendProactivePush(threadID, `📞 ${call.reason} ·仍在响`, { kind: "incoming_call", callId: call.id });
      setTimeout(() => { void ring(); }, 2_000);
    } catch (error) {
      console.warn(`incoming call ring stopped: ${error.message}`);
    }
  };
  setTimeout(() => { void ring(); }, 2_000);
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
    const dial = extractDialMarker(generated.content);
    const now = new Date().toISOString();
    thread.messages.push({ id: randomUUID(), role: "assistant", content: dial.content, createdAt: now });
    const invite = dial.reason ? await createIncomingCallInvite(thread, dial.reason) : null;
    await saveThreads(threads);
    if (invite) startIncomingCallRing(threadId, invite);
    proactiveSettings.scheduledForUserMessageId = lastUser.id;
    await saveProactiveSettings();
    console.log(`proactive nudge saved for chat ${threadId}`);
    await sendProactivePush(threadId, invite ? `📞 ${invite.reason}` : dial.content, invite ? { kind: "incoming_call", callId: invite.id } : null);
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
function cacheUsage(usage = {}) {
  const read = Number(usage.cache_read_input_tokens || usage.prompt_tokens_details?.cached_tokens || 0);
  const created = Number(usage.cache_creation_input_tokens || usage.prompt_tokens_details?.cache_creation_input_tokens || usage.cache_creation?.ephemeral_1h_input_tokens || usage.cache_creation?.ephemeral_5m_input_tokens || 0);
  return { read, created };
}

async function callModel({ messages, temperature = 0.8, maxOutputTokens, cacheCurrentUser = true, onUsage }) {
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
  if (onUsage) onUsage(usage);
  cacheStats.lastUsage = usage;
  const cache = cacheUsage(usage);
  cacheStats.cacheReadTokens += cache.read;
  cacheStats.cacheWriteTokens += cache.created;
  await saveCacheStats().catch((error) => console.warn(`cache stats save skipped: ${error.message}`));
  const content = nativeAnthropic
    ? data?.content?.filter((block) => block.type === "text").map((block) => block.text).join("")
    : data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("模型没有返回内容");
  return content.trim();
}

async function zenMuxSubscriptionUsage() {
  const apiKey = String(process.env.ZENMUX_MANAGEMENT_API_KEY || "").trim();
  if (!apiKey) throw new Error("尚未配置 ZenMux 管理密钥");
  const endpoint = String(process.env.ZENMUX_MANAGEMENT_API_URL || "https://zenmux.ai/api/v1/management/subscription/detail").trim();
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.success === false) throw new Error(result?.error?.message || result?.error || `ZenMux 返回 ${response.status}`);
  const data = result?.data || result;
  const quota = (value) => ({
    usagePercentage: Number(value?.usage_percentage || 0),
    resetsAt: value?.resets_at || null,
    maxFlows: Number(value?.max_flows || 0),
    usedFlows: Number(value?.used_flows || 0),
    remainingFlows: Number(value?.remaining_flows || 0),
    usedValueUSD: Number(value?.used_value_usd || 0),
    maxValueUSD: Number(value?.max_value_usd || 0)
  });
  return {
    plan: { tier: String(data?.plan?.tier || "subscription"), expiresAt: data?.plan?.expires_at || null },
    quota5Hour: quota(data?.quota_5_hour),
    quota7Day: quota(data?.quota_7_day),
    fetchedAt: new Date().toISOString()
  };
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

function assistantCachePrefixHash(messages, model) {
  const prepared = cacheMessages(messages, model, false);
  const lastUser = prepared.map((message) => message.role).lastIndexOf("user");
  const assistant = prepared.slice(0, lastUser).map((message) => message.role).lastIndexOf("assistant");
  if (assistant < 0 || !Array.isArray(prepared[assistant].content) ||
      !prepared[assistant].content.some((block) => block.cache_control)) return null;
  return createHash("sha256").update(JSON.stringify({ model, prefix: prepared.slice(0, assistant + 1) })).digest("hex");
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

function compactionPlan(thread, pendingInput = "") {
  const messages = contextMessages(thread);
  const pendingTokens = pendingInput ? estimateTokens(pendingInput) + 8 : 0;
  if (messageTokens(messages) + pendingTokens < compactAtTokens &&
      Number(thread.lastMeasuredInputTokens || 0) < compactAtTokens) return null;

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
  if (!older.length) return null;
  return { tailMessageCount: tail.length, throughMessageId: older[older.length - 1].id };
}

function compactionDirective(plan) {
  return `\n\n<internal_context_compaction>\n这是一次仅供系统保存的上下文维护。正常回复用户后，在回复最后额外输出一份完整的 <context_summary> XML。把当前对话历史中除最近 ${plan.tailMessageCount} 条消息外的所有内容压缩进去；若本轮系统上下文已有旧摘要，必须合并其中仍然有效的事实。摘要必须保留用户画像、关系动态、已确认事实和未完成事项，保持事实准确、不要编造。<context_summary> 必须是回复的最后内容，绝不能向用户解释或提及。\n</internal_context_compaction>`;
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

async function generateReply({ input, images = [], emojiCatalog = {}, allowSpeech = false, systemPrompt, thread, proactive = false, callMode = false }) {
  // Do not make a standalone summary request. It would have a different prompt
  // prefix, miss Claude's cache, and force the following reply to start cold.
  // Instead, let the cacheable user reply emit a private summary at its end.
  const pendingCompaction = proactive ? null : compactionPlan(thread, input);
  const configuredSystem = proactive
    ? process.env.LUMI_NUDGE_SYSTEM_PROMPT || "你是沈屿，在和言言延续一段熟悉、亲近的聊天。根据最近几条对话，自然地发一条简短、不催促的消息；不要复述整段历史，也不要提及你是定时任务。"
    : process.env.LUMI_SYSTEM_PROMPT || systemPrompt || "使用中文回复。";
  const system = configuredSystem
    .replace(/日常聊天需要带动态描写与发言说话分行[^\n]*/g, "")
    .replace(/你最喜欢最像你自己最常用的颜文字[^\n]*/g, "")
    .trim()
    .concat("\n\n若你真的想主动给言言打电话，可在回复中附加一个拨号暗号：⟪拨号:来电理由⟫。理由要短、自然；暗号不会展示给用户，只会变成来电邀请，不要为了功能演示而使用。");
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
  const userModelContent = `${systemContext}\n\n${input}${pendingCompaction ? compactionDirective(pendingCompaction) : ""}`;
  const cacheSystem = `${system}\n\n你可以自行决定要不要使用颜文字，不必每条都用。若决定使用用户的颜文字库，只在回复末尾输出 <emoji_mood>一个可用心情标签</emoji_mood>；没有决定使用就不要输出此标签。系统随后只读取这个心情里的颜文字，标签不要展示给用户。你可以使用标签添加记忆，自行判断这需不需要记录下这一刻，不要太频繁也不要一点不记。需要记忆时仅在回复末尾添加 <memory>要记住的原文</memory>，不要向用户解释这个标签。当前用户消息可能包含 <internal_context_compaction>；仅当它存在时，按其中要求在正常回复后输出私有 <context_summary>，该标签及内容绝不能展示或解释给用户。当前用户消息若包含 <internal_call_request> 或 <internal_call_turn>，这是电话场景：只输出对方能听见或看见的自然说话内容，绝不输出 <thinking>、思考过程、动作说明或任何解释内部标签的文字。仅当本轮 <speech_enabled>true</speech_enabled> 时，你可以自主判断是否值得发一条语音，不要每条都配语音；决定使用时才在回复最后附加 <speech>单独要朗读的一句话</speech>。这句话必须和正文不同，不得复述或改写正文；不要使用颜文字、emoji、动作描写、位置提示、换行或任何标签。如果本轮标记为 false，禁止输出 speech 标签。普通文字回复始终照常显示，语音标签只供系统生成音频，绝不能把标签展示给用户。thinking 中不要讨论 speech_enabled、语音开关或是否发语音。`;
  const cacheRequestMessages = [
    { role: "system", content: cacheSystem },
    ...history,
    // Keep request-specific context (timestamp, retrieved memories, rolling summary) in the
    // uncached suffix. Putting it in `system` changes Anthropic's system prefix every turn and
    // invalidates the message-cache prefix even when all earlier chat turns are unchanged.
    { role: "user", content: userModelContent, images }
  ];
  // Compare the actual cache boundary in this request with the preceding
  // keepalive. Only hashes and booleans are stored; prompts stay private.
  const previousKeepaliveAt = Number(thread.cacheKeepaliveAt || 0);
  const previousRequestAt = Number(thread.cacheRequestStartedAt || 0);
  const cacheContinuity = previousKeepaliveAt >= previousRequestAt && thread.cacheKeepalivePrefixHash
    ? (() => {
        const model = process.env.LUMI_MODEL_NAME || "";
        const actualHash = assistantCachePrefixHash(cacheRequestMessages, model);
        return {
          keepaliveAt: new Date(previousKeepaliveAt).toISOString(),
          sameSystemPrompt: cacheSystem === thread.cacheSystem,
          sameModel: model === thread.cacheModel,
          sameAssistantPrefix: actualHash !== null && actualHash === thread.cacheKeepalivePrefixHash,
          assistantBreakpointPresent: actualHash !== null,
          keepalivePrefixHash: thread.cacheKeepalivePrefixHash.slice(0, 16),
          chatPrefixHash: actualHash?.slice(0, 16) || null
        };
      })()
    : null;
  const cacheRequestStartedAt = Date.now();
  let measuredInputTokens = 0;
  const raw = await callModel({
    maxOutputTokens: proactive ? 256 : pendingCompaction
      ? Math.max(Number(process.env.LUMI_MAX_OUTPUT_TOKENS || 8192), Number(process.env.LUMI_COMPACT_SUMMARY_TOKENS || 25000))
      : undefined,
    messages: cacheRequestMessages,
    onUsage: (usage) => {
      const { read: cachedRead, created: cachedWrite } = cacheUsage(usage);
      const promptTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
      // Native Anthropic reports uncached input separately; some OpenAI gateways
      // include cached tokens in prompt_tokens while others report them separately.
      measuredInputTokens = usage.input_tokens != null || promptTokens < cachedRead + cachedWrite
        ? promptTokens + cachedRead + cachedWrite : promptTokens;
      if (!cacheContinuity) return;
      cacheContinuity.readTokens = cachedRead;
      cacheContinuity.writeTokens = cachedWrite;
    }
  });
  const compactedSummary = pendingCompaction
    ? raw.match(/<context_summary\b[^>]*>[\s\S]*?<\/context_summary>/i)?.[0]?.trim()
    : null;
  if (pendingCompaction && compactedSummary) {
    thread.contextSummary = compactedSummary;
    thread.compactionCount = (thread.compactionCount || 0) + 1;
    thread.compactedAt = new Date().toISOString();
    thread.compactedThroughMessageId = pendingCompaction.throughMessageId;
    thread.lastMeasuredInputTokens = 0;
  } else if (pendingCompaction) {
    console.warn("context compaction deferred: model response contained no context_summary");
  }
  const cleanedRaw = (callMode
    ? raw.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "").replace(/<thinking\b[^>]*>/gi, "").replace(/<\/thinking>/gi, "")
    : withoutSpeechPlanning(raw));
  const memoryMatch = cleanedRaw.match(/<memory>([\s\S]*?)<\/memory>/i);
  const speechMatch = allowSpeech ? cleanedRaw.match(/<speech>([\s\S]*?)<\/speech>/i) : null;
  const callDecision = cleanedRaw.match(/<call_decision>\s*(accept|reject)\s*<\/call_decision>/i)?.[1]?.toLowerCase() || null;
  const callUserText = cleanedRaw.match(/<call_user_text>([\s\S]*?)<\/call_user_text>/i)?.[1]?.trim() || null;
  const emojiMood = cleanedRaw.match(/<emoji_mood>([\s\S]*?)<\/emoji_mood>/i)?.[1]?.trim() || "";
  const memoryContent = memoryMatch?.[1]?.trim();
  const titleMatch = cleanedRaw.match(/<html_title>([\s\S]*?)<\/html_title>/i);
  let content = cleanedRaw.replace(/<memory>[\s\S]*?<\/memory>/gi, "").replace(/<speech>[\s\S]*?<\/speech>/gi, "").replace(/<emoji_mood>[\s\S]*?<\/emoji_mood>/gi, "").replace(/<call_decision>[\s\S]*?<\/call_decision>/gi, "").replace(/<call_user_text>[\s\S]*?<\/call_user_text>/gi, "").replace(/<context_summary\b[^>]*>[\s\S]*?<\/context_summary>/gi, "").replace(/<html_title>[\s\S]*?<\/html_title>/gi, "").trim();
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
  return { content, htmlContent: htmlBlock?.htmlContent || null, htmlTitle: htmlBlock?.htmlTitle || null, memorySaved, speechText, callDecision, callUserText, modelContent: raw.replace(/<context_summary\b[^>]*>[\s\S]*?<\/context_summary>/gi, "").trim(), userModelContent, cacheSystem, cacheRequestStartedAt, cacheKeepaliveMessages, cacheContinuity, measuredInputTokens };
}

async function checkCacheKeepalive() {
  if (!keepaliveEnabled || !promptCacheEnabled || keepaliveInFlight || chatRequestsInFlight || proactiveCheckInFlight ||
      !/anthropic|claude/i.test(process.env.LUMI_MODEL_NAME || "")) return { attempted: false, reason: "disabled_or_busy" };
  const id = "default";
  if (activeChatThreads.has(id)) return { attempted: false, reason: "chat_in_progress" };
  keepaliveInFlight = true;
  keepaliveDone = new Promise((resolve) => { finishKeepalive = resolve; });
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
    const assistantPrefixHash = assistantCachePrefixHash(keepaliveMessages, process.env.LUMI_MODEL_NAME);
    if (!assistantPrefixHash) return { attempted: false, reason: "assistant_cache_boundary_missing" };
    if (messageTokens(keepaliveMessages) < 1024) return { attempted: false, reason: "prefix_too_short" };
    const startedAt = Date.now();
    keepaliveState.attempts += 1;
    // Read the cached user prefix, then extend it through the exact assistant
    // reply that the next real chat will send as history.
    let keepaliveUsage = {};
    await callModel({
      messages: keepaliveMessages,
      maxOutputTokens: 16,
      temperature: 0,
      cacheCurrentUser: false,
      onUsage: (usage) => { keepaliveUsage = usage; }
    });
    const { read: readTokens, created: writeTokens } = cacheUsage(keepaliveUsage);
    thread.cacheKeepaliveAt = startedAt;
    thread.cacheKeepalivePrefixHash = assistantPrefixHash;
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
  } finally {
    keepaliveInFlight = false;
    finishKeepalive();
    finishKeepalive = null;
  }
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
    signal: AbortSignal.timeout(ttsTimeoutMs)
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
    if (url.pathname === "/v1/subscription/usage" && req.method === "GET") {
      if (!pushRequestAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, await zenMuxSubscriptionUsage());
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
      prompt: { enabled: promptCacheEnabled, model: process.env.LUMI_MODEL_NAME || "", explicitMode: /anthropic|claude/i.test(process.env.LUMI_MODEL_NAME || ""), strategy: "stable-history-v3-inline-compaction", ttl: cacheTTL, speechFallback: "full-visible-reply-v2", modelCalls: cacheStats.modelCalls, readTokens: cacheStats.cacheReadTokens, writeTokens: cacheStats.cacheWriteTokens, hitRate: cacheStats.cacheReadTokens + cacheStats.cacheWriteTokens > 0 ? Math.round(cacheStats.cacheReadTokens / (cacheStats.cacheReadTokens + cacheStats.cacheWriteTokens) * 10000) / 100 : null, lastUsage: cacheStats.lastUsage, lastChatContinuity: activeThread.cacheLastChatContinuity || null, keepalive: { enabled: keepaliveEnabled, intervalMs: keepaliveIntervalMs, maxIdleMs: keepaliveMaxIdleMs, attempts: keepaliveState.attempts, successes: keepaliveState.successes, readTokens: keepaliveState.readTokens, writeTokens: keepaliveState.writeTokens, lastReadTokens: keepaliveState.lastReadTokens, lastWriteTokens: keepaliveState.lastWriteTokens, lastAt: keepaliveState.lastAt, lastError: keepaliveState.lastError } },
        memory: { searches: cacheStats.memorySearches, hits: cacheStats.memoryCacheHits, results: cacheStats.memoryResults, lastError: cacheStats.memoryLastError, ttlMs: memoryCacheTTL }
      },
      compaction: { count: activeThread.compactionCount || 0, lastAt: activeThread.compactedAt || null, hasSummary: Boolean(activeThread.contextSummary), activeHistoryTokensEstimate: messageTokens(contextMessages(activeThread)), lastMeasuredInputTokens: activeThread.lastMeasuredInputTokens || 0, triggerTokensEstimate: compactAtTokens, preservedTailTokens: tailTokens }
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/memories") {
      const input = await body(req);
      if (typeof input.content !== "string" || !input.content.trim()) return send(res, 400, { error: "content_required" });
      const saved = await writeMemory(input.content.trim(), input.threadId || "manual");
      return send(res, saved ? 201 : 502, { saved });
    }
    const pendingCallMatch = url.pathname.match(/^\/v1\/chats\/([^/]+)\/calls\/pending$/);
    if (req.method === "GET" && pendingCallMatch) {
      const [, rawThreadID] = pendingCallMatch;
      const threads = await readThreads();
      const thread = threads[decodeURIComponent(rawThreadID)];
      if (!thread) return send(res, 200, { call: null });
      const pending = (thread.calls || []).find((item) => item.initiator === "assistant" && item.state === "pending");
      if (!pending) return send(res, 200, { call: null });
      if (Date.now() >= new Date(pending.expiresAt || 0).getTime()) {
        pending.state = "ended";
        pending.endedAt = new Date().toISOString();
        thread.messages.push({ id: randomUUID(), role: "assistant", content: `我刚刚想打电话给你，但你没有接到。${pending.reason || "等你有空再找我"}，不急，回来再和我说话。`, contentType: "call_status", callID: pending.id, callInitiator: "assistant", callStatus: "missed", createdAt: pending.endedAt });
        await saveThreads(threads);
        return send(res, 200, { call: null });
      }
      return send(res, 200, { call: { callId: pending.id, reason: pending.reason, createdAt: pending.createdAt, expiresAt: pending.expiresAt } });
    }
    const answerCallMatch = url.pathname.match(/^\/v1\/chats\/([^/]+)\/calls\/([^/]+)\/answer$/);
    if (req.method === "POST" && answerCallMatch) {
      const [, rawThreadID, callID] = answerCallMatch;
      const input = await body(req);
      const action = input.action === "accept" ? "accept" : "decline";
      const threads = await readThreads();
      const thread = threads[decodeURIComponent(rawThreadID)];
      const call = thread?.calls?.find((item) => item.id === callID && item.initiator === "assistant");
      if (!call) return send(res, 404, { error: "call_not_found" });
      if (call.state !== "pending") return send(res, 409, { error: "call_not_pending" });
      if (Date.now() >= new Date(call.expiresAt || 0).getTime()) return send(res, 410, { error: "call_expired" });
      const now = new Date().toISOString();
      if (action === "decline") {
        call.state = "ended";
        call.endedAt = now;
        let generated;
        try {
          generated = await generateReply({
            input: `<internal_call_declined>言言拒绝了你刚才主动发起的电话。${input.note ? `她留下的理由是：${String(input.note).slice(0, 120)}。` : "她没有留下理由。"}请自然地发一条聊天消息，理解她可能在忙，不要责怪，也不要提及内部标签。</internal_call_declined>`,
            systemPrompt: input.systemPrompt,
            thread,
            callMode: true
          });
        } catch {
          generated = { content: "没关系，你先忙，等你有空我们再说。", memorySaved: false };
        }
        const assistantMessage = { id: randomUUID(), role: "assistant", content: generated.content || "没关系，你先忙，等你有空我们再说。", contentType: "call_status", callID: call.id, callInitiator: "assistant", callStatus: "rejected", createdAt: now };
        thread.messages.push(assistantMessage);
        await saveThreads(threads);
        return send(res, 200, { callId: call.id, status: "declined", assistantMessage });
      }
      let generated;
      try {
        generated = await generateReply({
          input: `<internal_call_accepted>言言接起了你主动发起的电话。请自然地说出接通后的第一句话，可以分成多段短句，每句单独换行。不要提及内部标签。</internal_call_accepted>`,
          systemPrompt: input.systemPrompt,
          thread,
          callMode: true,
          allowSpeech: Boolean(input.tts?.apiKey && input.tts?.enabled)
        });
      } catch (error) {
        return send(res, 502, { error: error.message || "call_opening_failed" });
      }
      const openingText = extractDialMarker(generated.content).content || "喂，听得到吗？";
      const opening = { id: randomUUID(), role: "assistant", content: openingText, createdAt: now, speechScript: openingText };
      call.state = "active";
      call.startedAt = now;
      call.turns = [opening];
      let speech = null;
      let speechError = null;
      if (input.tts?.enabled && openingText) {
        try { speech = await synthesizeSpeech(openingText, input.tts); }
        catch (error) { speechError = (error.message || String(error)).slice(0, 200); }
      } else if (openingText) speechError = "客户端没有提供 MiniMax TTS 配置";
      await saveThreads(threads);
      return send(res, 200, { callId: call.id, status: "accepted", firstMessage: opening, speechAudioBase64: speech?.audioBase64 || null, speechDuration: speech?.duration || null, speechScript: speech ? openingText : null, speechError });
    }
    const callEndMatch = url.pathname.match(/^\/v1\/chats\/([^/]+)\/calls\/([^/]+)\/end$/);
    if (req.method === "POST" && callEndMatch) {
      const [, rawThreadID, callID] = callEndMatch;
      const threads = await readThreads();
      const thread = threads[decodeURIComponent(rawThreadID)];
      const call = thread?.calls?.find((item) => item.id === callID);
      if (!call) return send(res, 404, { error: "call_not_found" });
      if (call.recordMessage) {
        return send(res, 200, { callId: call.id, duration: Number(call.duration || 0), recordMessage: call.recordMessage });
      }
      const endedAt = new Date().toISOString();
      const duration = Math.max(0, (new Date(endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000);
      const transcript = (call.turns || []).map((turn) => `${turn.role === "user" ? "我" : "沈屿"}：${turn.content}`).join("\n");
      const recordMessage = {
        id: randomUUID(),
        role: "assistant",
        content: transcript || "这通电话没有留下文字记录。",
        contentType: "call_record",
        createdAt: endedAt,
        callID: call.id,
        callDuration: duration,
        callInitiator: call.initiator === "user" ? "user" : "assistant"
      };
      call.state = "ended";
      call.endedAt = endedAt;
      call.duration = duration;
      call.recordMessage = recordMessage;
      thread.messages.push(recordMessage);
      await saveThreads(threads);
      return send(res, 200, { callId: call.id, duration, recordMessage });
    }
    const callTurnMatch = url.pathname.match(/^\/v1\/chats\/([^/]+)\/calls\/([^/]+)\/messages$/);
    if (req.method === "POST" && callTurnMatch) {
      const [, rawThreadID, callID] = callTurnMatch;
      const input = await body(req);
      const spoken = String(input.content || "").trim();
      if (!spoken) return send(res, 400, { error: "content_required" });
      const threads = await readThreads();
      const thread = threads[decodeURIComponent(rawThreadID)];
      const call = thread?.calls?.find((item) => item.id === callID && item.state === "active");
      if (!call) return send(res, 404, { error: "call_not_found" });
      const transcript = call.turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n").slice(-16000);
      const generated = await generateReply({
        input: `<internal_call_turn>这是正在进行的语音通话。已发生的通话记录：\n${transcript}\n\n言言刚刚说（可能来自语音识别）：${spoken}\n\n先在理解时自动纠正常见同音字或错别字，保持原意；把纠正后的用户原句放在最后的 <call_user_text>...</call_user_text> 中，这个标签不会展示给用户。然后自然回复。可以分成多段短句；如果有多句，请每句单独换行，方便电话里逐条显示和播放。不要解释内部标签。</internal_call_turn>`,
        allowSpeech: Boolean(input.tts?.apiKey && input.tts?.enabled), systemPrompt: input.systemPrompt, thread, callMode: true
      });
      const now = new Date().toISOString();
      const userTurn = { id: randomUUID(), role: "user", content: generated.callUserText || spoken, createdAt: now };
      const assistantTurn = { id: randomUUID(), role: "assistant", content: generated.content, createdAt: now, speechScript: generated.content };
      call.turns.push(userTurn, assistantTurn);
      let speech = null;
      let speechError = null;
      if (input.tts?.enabled && generated.content) {
        try { speech = await synthesizeSpeech(generated.content, input.tts); }
        catch (error) { speechError = (error.message || String(error)).slice(0, 200); console.warn(`call speech skipped: ${speechError}`); }
      } else if (generated.content) {
        speechError = "客户端没有提供 MiniMax TTS 配置";
      }
      await saveThreads(threads);
      return send(res, 200, { userTurn, assistantTurn, speechAudioBase64: speech?.audioBase64 || null, speechDuration: speech?.duration || null, speechScript: speech ? generated.content : null, speechError });
    }
    const match = url.pathname.match(/^\/v1\/chats\/([^/]+)(\/messages|\/calls)?$/);
    if (!match) return send(res, 404, { error: "not_found" });
    const id = decodeURIComponent(match[1]);
    const isChatPost = req.method === "POST" && Boolean(match[2]);
    // Let an already running probe finish before reading history. Reserve the
    // chat before any asynchronous work so a new probe cannot overtake it.
    if (isChatPost) {
      if (id === "default" && keepaliveInFlight) await keepaliveDone;
      chatRequestsInFlight += 1;
    }
    try {
    const threads = await readThreads();
    if (!threads[id]) threads[id] = { id, title: "新聊天", messages: [] };
    if (req.method === "GET" && !match[2]) return send(res, 200, threads[id]);
    if (req.method === "POST" && match[2] === "/calls") {
      const input = await body(req);
      const thread = threads[id];
      const callId = randomUUID();
      // One model call: the decision and opening line reuse the ordinary chat-cache prefix.
      const generated = await generateReply({
        input: `<internal_call_request initiator="user">言言正在拨给你。请自行决定接听或拒绝。无论结果都在最后输出 <call_decision>accept 或 reject</call_decision>。接听时，先自然说出进入通话后的第一句话；如果有多句，请每句单独换行，方便电话里逐条显示和播放。拒绝时，只说能显示在聊天里的拒绝理由。不要解释这个内部标签。</internal_call_request>`,
        allowSpeech: Boolean(input.tts?.apiKey && input.tts?.enabled),
        systemPrompt: input.systemPrompt,
        thread,
        callMode: true
      });
      const now = new Date().toISOString();
      if (generated.callDecision !== "accept") {
        const assistantMessage = { id: randomUUID(), role: "assistant", content: generated.content || "我现在不太方便接电话。", contentType: "call_status", callID: callId, callInitiator: "user", callStatus: "rejected", createdAt: now };
        thread.messages.push(assistantMessage);
        await saveThreads(threads);
        return send(res, 200, { callId, status: "rejected", assistantMessage, memorySaved: generated.memorySaved });
      }
      let speech = null;
      let speechError = null;
      if (input.tts?.enabled && generated.content) {
        try { speech = await synthesizeSpeech(generated.content, input.tts); }
        catch (error) { speechError = (error.message || String(error)).slice(0, 200); console.warn(`call opening speech skipped: ${speechError}`); }
      } else if (generated.content) {
        speechError = "客户端没有提供 MiniMax TTS 配置";
      }
      const opening = { id: randomUUID(), role: "assistant", content: generated.content, createdAt: now, speechScript: generated.content };
      const call = { id: callId, initiator: "user", state: "active", startedAt: now, turns: [opening] };
      thread.calls = Array.isArray(thread.calls) ? thread.calls : [];
      thread.calls.push(call);
      await saveThreads(threads);
      return send(res, 200, { callId, status: "accepted", firstMessage: opening, speechAudioBase64: speech?.audioBase64 || null, speechDuration: speech?.duration || null, speechScript: speech ? generated.content : null, speechError, memorySaved: generated.memorySaved });
    }
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
      threads[id].lastMeasuredInputTokens = generated.measuredInputTokens;
      threads[id].cacheKeepaliveMessages = generated.cacheKeepaliveMessages;
      threads[id].cacheLastChatContinuity = generated.cacheContinuity;
      keepaliveState.lastThreadId = id;
      keepaliveState.lastRequestAt = generated.cacheRequestStartedAt;
      keepaliveState.disabledForMessageId = "";
      const dial = extractDialMarker(generated.content);
      const visibleContent = dial.content;
      const contentType = generated.htmlContent ? (visibleContent ? "mixed" : "html") : "text";
      let speech = null;
      if (input.tts?.enabled && generated.speechText && !generated.htmlContent) {
        try { speech = await synthesizeSpeech(generated.speechText, input.tts); }
        catch (error) { console.warn(`speech synthesis skipped: ${(error.message || String(error)).slice(0, 200)}`); }
      }
      const assistantMessage = {
        id: randomUUID(),
        role: "assistant",
        content: visibleContent,
        // Used only when reconstructing the exact model-side history for prompt cache.
        modelContent: generated.modelContent,
        contentType,
        htmlContent: generated.htmlContent,
        htmlTitle: generated.htmlTitle,
        createdAt: new Date().toISOString()
      };
      threads[id].messages.push(storedUserMessage, assistantMessage);
      const invite = dial.reason ? await createIncomingCallInvite(threads[id], dial.reason) : null;
      await saveThreads(threads);
      if (invite) startIncomingCallRing(id, invite);
      if (proactiveSettings.threadId === id) {
        proactiveSettings.scheduledForUserMessageId = userMessage.id;
        proactiveSettings.nextDueAt = new Date(Date.now() + chooseNudgeIntervalMs()).toISOString();
        await saveProactiveSettings();
      }
      // Normal replies can finish while the iOS app is suspended. Reuse the
      // registered APNs destination so the user is notified when the reply is ready.
      await sendProactivePush(id, invite ? `📞 ${invite.reason}` : visibleContent, invite ? { kind: "incoming_call", callId: invite.id } : null);
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
    } finally { if (isChatPost) chatRequestsInFlight -= 1; }
  } catch (error) { return send(res, 500, { error: error.message }); }
});

await loadCacheStats();
await loadProactiveSettings();
await loadPushTokens();
server.listen(port, () => console.log(`Lumi server listening on :${port}`));
setInterval(() => { void checkProactiveNudge(); }, 60_000);
setInterval(() => { void checkCacheKeepalive(); }, 60_000);
