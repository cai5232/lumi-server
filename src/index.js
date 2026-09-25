import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT || 8787);
const dataDir = process.env.LUMI_DATA_DIR || join(process.cwd(), "data");
const threadPath = join(dataDir, "threads.json");
const cacheStatsPath = join(dataDir, "cache-stats.json");
const proactiveSettingsPath = join(dataDir, "proactive-settings.json");
const contextLimit = Number(process.env.LUMI_CONTEXT_LIMIT || 200000);
const compactAt = Number(process.env.LUMI_COMPACT_AT || 0.85);
const tailTokens = Number(process.env.LUMI_COMPACT_TAIL_TOKENS || 20000);
const memoryAPI = (process.env.LUMI_MEMORY_API_URL || "https://memorycore.zeabur.app").replace(/\/$/, "");
const memorySearchPath = process.env.LUMI_MEMORY_SEARCH_PATH || "/api/search";
const memoryWritePath = process.env.LUMI_MEMORY_WRITE_PATH || "/api/integrations/nook/memories";
const memoryCacheTTL = Number(process.env.LUMI_MEMORY_CACHE_TTL_MS || 300000);
const modelKeywordExtraction = process.env.LUMI_MEMORY_KEYWORD_MODEL === "true";
const memorySearchCache = new Map();
const promptCacheEnabled = process.env.LUMI_PROMPT_CACHE_ENABLED !== "false";
const cacheTTL = process.env.LUMI_PROMPT_CACHE_TTL || "5m";
const cacheStats = { modelCalls: 0, cacheReadTokens: 0, cacheWriteTokens: 0, memorySearches: 0, memoryCacheHits: 0, lastUsage: {} };
const proactiveSettings = { enabled: false, threadId: "default", message: "有一段时间没聊了，结合我们的上下文自然地来找我说句话。", intervalMin: 60, intervalMax: 60, nextDueAt: null, scheduledForUserMessageId: null };
let proactiveCheckInFlight = false;
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
    for (const key of ["modelCalls", "cacheReadTokens", "cacheWriteTokens", "memorySearches", "memoryCacheHits"]) {
      const value = Number(saved[key]);
      if (Number.isFinite(value) && value >= 0) cacheStats[key] = value;
    }
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

function chooseNudgeIntervalMs() {
  const min = Math.max(10, Number(proactiveSettings.intervalMin) || 60);
  const max = Math.max(min, Number(proactiveSettings.intervalMax) || min);
  return (min + Math.random() * (max - min)) * 60_000;
}

async function checkProactiveNudge() {
  if (proactiveCheckInFlight || !proactiveSettings.enabled || !String(proactiveSettings.message || "").trim()) return;
  proactiveCheckInFlight = true;
  try {
    const threads = await readThreads();
    const threadId = proactiveSettings.threadId || "default";
    const thread = threads[threadId];
    if (!thread) return;
    const messages = thread.messages || [];
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    if (proactiveSettings.scheduledForUserMessageId !== lastUser.id || !proactiveSettings.nextDueAt) {
      proactiveSettings.scheduledForUserMessageId = lastUser.id;
      proactiveSettings.nextDueAt = new Date(new Date(lastUser.createdAt).getTime() + chooseNudgeIntervalMs()).toISOString();
      await saveProactiveSettings();
      return;
    }
    if (Date.now() < new Date(proactiveSettings.nextDueAt).getTime()) return;

    // Reserve the next interval before calling the model so a restart cannot duplicate a paid nudge.
    proactiveSettings.scheduledForUserMessageId = null;
    proactiveSettings.nextDueAt = new Date(Date.now() + chooseNudgeIntervalMs()).toISOString();
    await saveProactiveSettings();
    const input = `[nudge] ${String(proactiveSettings.message).trim()}`;
    const generated = await generateReply({ input, systemPrompt: "", thread });
    const now = new Date().toISOString();
    thread.messages.push(
      { id: randomUUID(), role: "user", content: input, createdAt: now },
      { id: randomUUID(), role: "assistant", content: generated.content, createdAt: new Date().toISOString() }
    );
    await saveThreads(threads);
    proactiveSettings.scheduledForUserMessageId = thread.messages.at(-2).id;
    proactiveSettings.nextDueAt = new Date(Date.now() + chooseNudgeIntervalMs()).toISOString();
    await saveProactiveSettings();
    console.log(`proactive nudge saved for chat ${threadId}`);
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
function contextMessages(thread) {
  const messages = thread.messages || [];
  const boundaryId = thread.compactedThroughMessageId;
  if (!boundaryId) return messages;
  const boundaryIndex = messages.findIndex((message) => message.id === boundaryId);
  return boundaryIndex >= 0 ? messages.slice(boundaryIndex + 1) : messages;
}
function messageTokens(messages) { return messages.reduce((total, message) => total + estimateTokens(message.content) + 8, 0); }

async function callModel({ messages, temperature = 0.8 }) {
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

  const preparedMessages = cacheMessages(messages, model);
  const requestBody = nativeAnthropic
    ? {
        model: process.env.LUMI_NATIVE_ANTHROPIC_MODEL || zenmuxAnthropicModel(model),
        max_tokens: Number(process.env.LUMI_MAX_OUTPUT_TOKENS || 8192),
        system: preparedMessages.filter((message) => message.role === "system").flatMap((message) => Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content || "") }]),
        messages: preparedMessages.filter((message) => message.role !== "system"),
        temperature
      }
    : { model, messages: preparedMessages, temperature };

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
  cacheStats.cacheReadTokens += Number(usage?.prompt_tokens_details?.cached_tokens || usage?.cache_read_input_tokens || usage?.cache_read_input_tokens || 0);
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

function cacheMessages(messages, model) {
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
  if (cacheBoundary >= 0 && typeof cloned[cacheBoundary].content === "string" && prefixTokens >= 1024) {
    cloned[cacheBoundary] = { ...cloned[cacheBoundary], content: [{ type: "text", text: cloned[cacheBoundary].content, cache_control: { type: "ephemeral", ttl: cacheTTL } }] };
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

async function extractMemoryKeywords(input) {
  if (!modelKeywordExtraction) return fallbackKeywords(input);
  try {
    const raw = await callModel({
      messages: [
        { role: "system", content: "从用户这条消息中提取用于检索长期记忆的关键词。只输出 JSON 数组，例如 [\"称呼\",\"偏好\"]，不要解释，不要复述原句。" },
        { role: "user", content: input }
      ],
      temperature: 0
    });
    const parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === "string" && item.trim()).slice(0, 8);
  } catch {}
  return fallbackKeywords(input);
}

function normalizeMemories(data) {
  const list = Array.isArray(data) ? data : data.memories || data.results || data.data || [];
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
  try { return normalizeMemories(await memorySearchRequest(query)); }
  catch (error) { console.warn(`memory search skipped: ${error.message}`); return []; }
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
  if (messageTokens(messages) + pendingTokens < contextLimit * compactAt) return false;

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
  const prompt = `${previous}请把下面的聊天历史压缩成长期上下文摘要。只输出 XML，不要解释：
<context_summary>
  <user_profile>称呼、偏好、语言习惯与长期信息</user_profile>
  <relationship_dynamic>关系背景、相处氛围与角色状态</relationship_dynamic>
  <key_decisions_and_facts>确认过的事实、约定、重要事件</key_decisions_and_facts>
  <active_topics_and_todos>当前话题、未完成事项与下一步</active_topics_and_todos>
</context_summary>
聊天历史：
${older.map((message) => `${message.role}: ${message.content}`).join("\n")}`;
  thread.contextSummary = await callModel({
    messages: [
      { role: "system", content: "你是上下文压缩器。保持事实，不编造，不输出聊天回复。" },
      { role: "user", content: prompt }
    ],
    temperature: 0.2
  });
  thread.compactionCount = (thread.compactionCount || 0) + 1;
  thread.compactedAt = new Date().toISOString();
  thread.compactedThroughMessageId = older[older.length - 1].id;
  return true;
}

async function generateReply({ input, systemPrompt, thread }) {
  await compactThread(thread, input);
  const system = process.env.LUMI_SYSTEM_PROMPT || systemPrompt || "使用中文回复。";
  const summary = thread.contextSummary ? `\n\n<context_summary>\n${thread.contextSummary}\n</context_summary>` : "";
  const memories = await searchMemories(input);
  const retrieved = memories.length
    ? `\n\n<retrieved_memories>\n${memories.map((memory) => `- ${memory}`).join("\n")}\n</retrieved_memories>`
    : "";
  const history = contextMessages(thread).map((message) => ({ role: message.role, content: message.content }));
  const dynamicContext = `${summary}${retrieved}`.trim();
  const userContent = dynamicContext
    ? `${dynamicContext}\n\n${input}`
    : input;
  const raw = await callModel({
    messages: [
      { role: "system", content: `${system}\n\n如果这条对话包含值得长期保留的新事实、偏好或约定，你可以在回复末尾添加 <memory>要记住的内容</memory>；不值得记忆时不要添加。不要向用户解释这个标签。` },
      ...history,
      { role: "user", content: userContent }
    ]
  });
  const memoryMatch = raw.match(/<memory>([\s\S]*?)<\/memory>/i);
  const memoryContent = memoryMatch?.[1]?.trim();
  const content = raw.replace(/<memory>[\s\S]*?<\/memory>/gi, "").trim();
  const memorySaved = memoryContent ? await writeMemory(memoryContent, thread.id) : false;
  return { content, memorySaved };
}

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
    if (url.pathname === "/v1/settings/proactive" && req.method === "GET") return send(res, 200, proactiveSettings);
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
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, {
      ok: true,
      cache: {
      prompt: { enabled: promptCacheEnabled, model: process.env.LUMI_MODEL_NAME || "", explicitMode: /anthropic|claude/i.test(process.env.LUMI_MODEL_NAME || ""), modelCalls: cacheStats.modelCalls, readTokens: cacheStats.cacheReadTokens, writeTokens: cacheStats.cacheWriteTokens, hitRate: cacheStats.cacheReadTokens + cacheStats.cacheWriteTokens > 0 ? Math.round(cacheStats.cacheReadTokens / (cacheStats.cacheReadTokens + cacheStats.cacheWriteTokens) * 10000) / 100 : null, lastUsage: cacheStats.lastUsage },
        memory: { searches: cacheStats.memorySearches, hits: cacheStats.memoryCacheHits, ttlMs: memoryCacheTTL }
      }
    });
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
      if (typeof input.content !== "string" || !input.content.trim()) return send(res, 400, { error: "content_required" });
      const userMessage = { id: randomUUID(), role: "user", content: input.content.trim(), createdAt: new Date().toISOString() };
      const generated = await generateReply({ input: userMessage.content, systemPrompt: input.systemPrompt, thread: threads[id] });
      const assistantMessage = {
        id: randomUUID(),
        role: "assistant",
        content: generated.content,
        createdAt: new Date().toISOString()
      };
      threads[id].messages.push(userMessage, assistantMessage);
      await saveThreads(threads);
      if (proactiveSettings.threadId === id) {
        proactiveSettings.scheduledForUserMessageId = userMessage.id;
        proactiveSettings.nextDueAt = new Date(Date.now() + chooseNudgeIntervalMs()).toISOString();
        await saveProactiveSettings();
      }
      return send(res, 200, { userMessage, assistantMessage, memorySaved: generated.memorySaved });
    }
    return send(res, 405, { error: "method_not_allowed" });
  } catch (error) { return send(res, 500, { error: error.message }); }
});

await loadCacheStats();
await loadProactiveSettings();
server.listen(port, () => console.log(`Lumi server listening on :${port}`));
setInterval(() => { void checkProactiveNudge(); }, 60_000);
