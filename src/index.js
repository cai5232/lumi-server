import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
const galleryDir = join(dataDir, "gallery");
const diaryPath = join(dataDir, "diaries.json");
const screenShareDir = join(dataDir, "screen-share");
const contextLimit = Number(process.env.LUMI_CONTEXT_LIMIT || 200000);
const compactAtTokens = Math.min(Number(process.env.LUMI_COMPACT_AT_TOKENS || 68888), Math.floor(contextLimit * 0.85));
const tailTokens = Number(process.env.LUMI_COMPACT_TAIL_TOKENS || 20000);
const memoryAPI = (process.env.LUMI_MEMORY_API_URL || "https://memorycore.zeabur.app").replace(/\/$/, "");
const memorySearchPath = process.env.LUMI_MEMORY_SEARCH_PATH || "/api/integrations/nook/recall";
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
const proactiveSettings = { enabled: false, threadId: "default", message: "有一段时间没聊了，结合我们的上下文自然地来找我说句话。", intervalMin: 60, intervalMax: 60, nextDueAt: null, scheduledForUserMessageId: null, lastNudgedForUserMessageId: null, actions: { message: true, phone: true, screen: false } };
let proactiveCheckInFlight = false;
let pushTokens = [];
let apnsJwtCache = { token: "", createdAt: 0 };
const activeChatThreads = new Set();
const recentMessageRequests = new Map();
const chatPersistenceQueues = new Map();
const providerConfigs = () => [
  { id: "zenmux", url: process.env.LUMI_MODEL_API_URL, key: process.env.LUMI_MODEL_API_KEY, model: process.env.LUMI_MODEL_NAME },
  { id: "backup", url: process.env.LUMI_MODEL_API_URL_2, key: process.env.LUMI_MODEL_API_KEY_2, model: process.env.LUMI_MODEL_NAME_2 || null }
].filter((item) => item.url && item.key);

function providerConfig(id = "zenmux", modelOverride = "") {
  const config = providerConfigs().find((item) => item.id === id);
  if (!config) throw new Error(`${id === "backup" ? "备用中转" : "ZenMux"}线路尚未配置`);
  return { ...config, model: modelOverride || config.model };
}

async function listProviderModels(config) {
  try {
    const baseURL = String(config.url).replace(/\/chat\/completions\/?$/i, "").replace(/\/$/, "");
    const response = await fetch(`${baseURL}/models`, { headers: { authorization: `Bearer ${config.key}` } });
    const data = await response.json().catch(() => ({}));
    const models = Array.isArray(data?.data) ? data.data.map((item) => item.id).filter(Boolean) : [];
    return models;
  } catch { return []; }
}
// Older iOS builds may retry a timed-out POST more than a minute later.
// Keep exact-body results long enough to cover their three attempts.
const legacyRetryWindowMs = 3 * 60_000;
let memoryCookie = "";
const sleepDelayMinutes = Number(process.env.LUMI_SLEEP_DELAY_MINUTES || 60);
const sleepHours = Number(process.env.LUMI_SLEEP_HOURS || 5.5);
const sleepCycles = Number(process.env.LUMI_SLEEP_CYCLES || 3);
const sleepInsomniaProbability = Number(process.env.LUMI_SLEEP_INSOMNIA_PROBABILITY || 0.15);

const SLEEP_STAGE_PROMPTS = {
  n1_drift: {
    system: "你是 N1 漂移睡眠阶段。只从今天的经历中挑选值得回看的碎片，不解释，不下结论。",
    user: ({ goals, memories }) => `当前目标：${goals}\n\n候选记忆（按显著性排序）：\n${memories}\n\n返回 3-5 个碎片，每行格式：- [记忆ID] 一句重新描述。`
  },
  n2_spindle: {
    system: "你是 N2 睡眠纺锤阶段。把漂移碎片按主题、意象和情绪聚类，不要抽象成事实。",
    user: ({ n1 }) => `N1 碎片：\n${n1}\n\n输出：THEMES: 2-4 个短语；CLUSTERS: 每个主题对应碎片 ID；EMOTIONAL_TONE: 一行。`
  },
  n3_deep: {
    system: "你是 N3 深睡 consolidation 阶段。保守地把经历压缩成长期语义事实和规则，只输出置信度至少 0.6 的内容。",
    user: ({ n2, semantic }) => `聚类：\n${n2}\n\n已有语义记忆：\n${semantic}\n\n严格返回 JSON：{"facts":[{"fact":"...","sources":["id"],"confidence":0.0}],"rules":[{"if":"...","then":"...","confidence":0.0}],"forget":["id"]}`
  },
  rem: {
    system: "你是 REM 梦境导演。把记忆和语义知识编织成连续、奇异但有情绪真相的第一人称梦境。",
    user: ({ seeds, semantic, goals, cycle, previousDream, contextSummary, retrievedMemories }) => `梦境周期 ${cycle}。种子：\n${seeds}\n\n语义背景：${semantic}\n\n目标：${goals}\n\n最近对话压缩摘要：${contextSummary || "（无）"}\n\n长期记忆：${retrievedMemories || "（无）"}\n\n上一段梦境（必须承接意象、人物或未完成动作，不要另起炉灶）：${previousDream || "（这是第一段梦）"}\n\n写 3 个连续场景，每段以 SCENE 1/2/3 开头，末行 DREAM_EMOTION: <词>。`
  },
  nightmare: {
    system: "你是噩梦阶段：受控的对抗性模拟器。放大真实失败模式，但必须给出可行的恢复路径。",
    user: ({ trauma, competence }) => `近期负面经历：\n${trauma}\n\n能力边界：${competence}\n\n输出：SCENARIO、ADVERSARIAL_TWIST、AGENT_DREAM_RESPONSE、OUTCOME(success|partial|failure)、MISSING_SKILL、RECOVERY_PATH，以及 AI_DECISION(send_message|continue_sleep|sentinel)。AI_DECISION 必须由你根据噩梦结果自行决定，不能交给用户选择。`
  },
  lucid: {
    system: "你是清醒梦阶段。AI 知道自己在做梦，用安全的想象练习当前目标。",
    user: ({ goals, obstacles }) => `目标：${goals}\n障碍：${obstacles}\n\n写 2-3 个具体梦境练习场景，末行 INSIGHT: 一句话。`
  },
  reflection: {
    system: "你是晨间反思阶段。只输出严格 JSON，不要 Markdown 或解释。",
    user: ({ summary, state }) => `夜间摘要：\n${summary}\n\n睡前状态：${state}\n\n返回：{"themes":[],"insights":[],"contradictions":[],"skill_gaps":[],"consolidation_plan":{"keep":[],"compress":[{"ids":[],"into":""}],"forget":[],"train_on":[{"dream_id":"","weight":0.0}],"value_changes":[]},"next_night_hints":[],"affect_delta":{"valence":0,"arousal":0}}`
  }
};

const seed = () => ({
  id: "default",
  title: "沈屿",
  messages: [{ id: randomUUID(), role: "assistant", content: "下午的风很轻，想和你说说话。", createdAt: new Date().toISOString() }],
  proactive: { enabled: false, threadId: "default", message: "有一段时间没聊了，结合我们的上下文自然地来找我说句话。", intervalMin: 60, intervalMax: 60, nextDueAt: null, scheduledForUserMessageId: null },
  activity: { mode: "sentinel", lastUserActivityAt: new Date().toISOString(), lastWakeAt: null, nextWakeAt: null, sleepPendingAt: null, sleepStage: null },
  sleep: { episodic: [], semantic: [], dreams: [], reflections: [], pendingDreams: [], nextCycle: 0, running: false, dreamArc: "", nightmare: null }
});

function ensureProactive(thread) {
  if (!thread.proactive) {
    thread.proactive = { enabled: false, threadId: thread.id, message: "有一段时间没聊了，结合我们的上下文自然地来找我说句话。", intervalMin: 60, intervalMax: 60, nextDueAt: null, scheduledForUserMessageId: null };
  }
  return thread.proactive;
}

function ensureActivity(thread) {
  if (!thread.activity) {
    thread.activity = { mode: "sentinel", lastUserActivityAt: new Date().toISOString(), lastWakeAt: null, nextWakeAt: null, sleepPendingAt: null };
  }
  if (!Object.prototype.hasOwnProperty.call(thread.activity, "lastWakeAt")) thread.activity.lastWakeAt = null;
  ensureProactive(thread);
  if (!thread.sleep) thread.sleep = { episodic: [], semantic: [], dreams: [], reflections: [], pendingDreams: [], nextCycle: 0, running: false, dreamArc: "", nightmare: null };
  if (!Array.isArray(thread.sleep.pendingDreams)) thread.sleep.pendingDreams = [];
  if (typeof thread.sleep.dreamArc !== "string") thread.sleep.dreamArc = "";
  if (!Object.prototype.hasOwnProperty.call(thread.sleep, "nightmare")) thread.sleep.nightmare = null;
  return thread.activity;
}

function isFarewell(text) {
  return /(晚安|睡了|先睡|去睡|明天见|先休息|good\s*night)/i.test(String(text || ""));
}

function markUserActivity(thread, content) {
  const activity = ensureActivity(thread);
  const proactive = ensureProactive(thread);
  const now = new Date();
  activity.mode = "sentinel";
  activity.lastUserActivityAt = now.toISOString();
  const interval = Math.max(1, Number(proactive.intervalMin) || 60);
  activity.nextWakeAt = proactive.enabled ? new Date(now.getTime() + interval * 60_000).toISOString() : null;
  proactive.nextDueAt = activity.nextWakeAt;
  activity.sleepPendingAt = isFarewell(content)
    ? new Date(now.getTime() + sleepDelayMinutes * 60_000).toISOString()
    : null;
  activity.sleepStartedAt = null;
  activity.sleepUntil = null;
  activity.nextDreamAt = null;
  activity.dreamCycle = 0;
  activity.sleepStage = null;
}

async function generateAutonomousMessage(thread, kind) {
  const proactive = ensureProactive(thread);
  const recent = (thread.messages || []).slice(-12).map((message) => `${message.role}: ${message.content}`).join("\n");
  const prompt = kind === "dream"
    ? "你正在睡眠中做梦。根据最近的聊天记忆，写一段连续梦境片段，保持和上一段梦的意象连贯，100字以内。只输出梦境正文。"
    : `你是一个会主动关心用户的 AI。用户已经有一段时间没有说话，请按照这条主动消息设定自然地发起联系：${proactive.message || "有一段时间没聊了，自然地来找用户说句话。"}。不要提到计时器、后台任务或系统。60字以内。`;
  const content = await callModel({
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: recent || "还没有聊天记录。" }
    ],
    temperature: kind === "dream" ? 1.0 : 0.8
  });
  return { id: randomUUID(), role: "assistant", content, contentType: kind === "dream" ? "dream" : "sentinel", createdAt: new Date().toISOString() };
}

async function generateSentinelWake(thread) {
  const proactive = ensureProactive(thread);
  const context = await buildAutonomousContext(thread);
  const recent = context.raw.map((message) => `${message.role}: ${message.content}`).join("\n");
  const contextSummary = context.summary ? `\n<context_summary>\n${context.summary}\n</context_summary>` : "";
  const retrievedMemories = context.memories.length ? `\n<retrieved_memories>\n${context.memories.map((memory) => `- ${memory}`).join("\n")}\n</retrieved_memories>` : "";
  const raw = await callModel({
    messages: [
      {
        role: "system",
        content: `你是一个会主动关心用户的 AI。根据主动消息设定“${proactive.message}”自然地发起联系。你还要自己决定下一次主动联系的间隔，单位是分钟，必须是 1 到 1440 的整数。自主唤醒必须结合最近十几条原文、对话压缩摘要和长期记忆，保持上下文连续。${contextSummary}${retrievedMemories}只输出 JSON，不要 Markdown：{"message":"要发给用户的话","nextWakeMinutes":整数}`
      },
      { role: "user", content: recent || "还没有聊天记录。" }
    ],
    temperature: 0.8
  });
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
  const message = typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : raw.trim();
  const fallback = Math.max(1, Number(proactive.intervalMin) || 60);
  const nextWakeMinutes = Math.min(1440, Math.max(1, Math.round(Number(parsed.nextWakeMinutes) || fallback)));
  return {
    message: { id: randomUUID(), role: "assistant", content: message, contentType: "sentinel", createdAt: new Date().toISOString() },
    nextWakeMinutes
  };
}

async function buildAutonomousContext(thread) {
  const raw = contextMessages(thread).filter((message) => message.role === "user" || message.role === "assistant").slice(-16);
  const summary = String(thread.contextSummary || "").trim();
  const query = [summary, ...raw.map((message) => message.content)].filter(Boolean).join("\n").slice(-2400);
  const memories = await searchMemories(query || "最近聊天 上下文");
  return { raw, summary, memories };
}

function safeJSON(text, fallback = {}) {
  try { return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text); } catch { return fallback; }
}

function sleepMemories(thread, context = {}) {
  const raw = Array.isArray(context.raw) ? context.raw : contextMessages(thread).filter((message) => message.role === "user" || message.role === "assistant").slice(-16);
  const memories = raw.map((m, index) => ({
    id: m.id || `m${index}`,
    ts: Date.parse(m.createdAt || 0) || Date.now(),
    content: `${m.role === "user" ? "用户" : "AI"}：${m.content}`,
    valence: m.role === "user" ? 0.1 : 0,
    arousal: Math.min(1, String(m.content || "").length / 300),
    rehearsalCount: 0,
    reward: 0,
    expectedReward: 0
  }));
  if (context.summary) memories.push({ id: "context-summary", ts: Date.now(), content: `对话压缩摘要：${context.summary}`, valence: 0, arousal: 0.3, rehearsalCount: 0, reward: 0, expectedReward: 0 });
  for (const [index, memory] of (context.memories || []).entries()) memories.push({ id: `retrieved-memory-${index + 1}`, ts: Date.now(), content: `长期记忆：${memory}`, valence: 0, arousal: 0.25, rehearsalCount: 0, reward: 0, expectedReward: 0 });
  return memories;
}

function salience(memory, goals = []) {
  const days = Math.max(0, (Date.now() - memory.ts) / 86400000);
  const recent = Math.exp(-days / 3);
  const goal = goals.some((g) => memory.content.toLowerCase().includes(String(g).toLowerCase())) ? 1 : 0;
  return Math.abs(memory.reward - memory.expectedReward) + 0.8 * memory.arousal + 0.5 * recent + 0.4 / (1 + memory.rehearsalCount) + 0.7 * goal;
}

function formatSleepMemories(memories, limit = 12) {
  return memories.slice(0, limit).map((m) => `- [${m.id}] valence=${m.valence.toFixed(2)} arousal=${m.arousal.toFixed(2)} :: ${m.content.slice(0, 220)}`).join("\n") || "（没有记忆）";
}

async function runSleepStage(thread, stage, cycle, context, seedIds = []) {
  const prompt = SLEEP_STAGE_PROMPTS[stage];
  const output = await callModel({
    messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user(context) }],
    temperature: stage === "n3_deep" ? 0.2 : stage === "rem" || stage === "nightmare" ? 1.0 : 0.6
  });
  const record = { id: randomUUID(), stage, cycle, content: output, seedIds, createdAt: new Date().toISOString() };
  thread.sleep.dreams.push(record);
  return record;
}

async function runFullSleepCycle(thread) {
  const activity = ensureActivity(thread);
  const sleep = thread.sleep;
  if (sleep.running) return;
  sleep.running = true;
  const context = await buildAutonomousContext(thread);
  const all = sleepMemories(thread, context);
  const goals = thread.goals || [];
  const obstacles = thread.obstacles || [];
  const scored = all.sort((a, b) => salience(b, goals) - salience(a, goals));
  const nightLog = [];
  try {
    for (let cycle = 0; cycle < sleepCycles; cycle += 1) {
      activity.sleepStage = `n1_drift_${cycle + 1}`;
      const seeds = scored.slice(0, 6 + cycle);
      const seedIds = seeds.map((m) => m.id);
      const n1 = await runSleepStage(thread, "n1_drift", cycle, { goals: goals.join(", ") || "（无）", memories: formatSleepMemories(seeds) }, seedIds);
      const n2 = await runSleepStage(thread, "n2_spindle", cycle, { n1: n1.content }, seedIds);
      const semanticText = sleep.semantic.map((f) => `- ${f.fact}`).join("\n") || "（空）";
      const n3 = await runSleepStage(thread, "n3_deep", cycle, { n2: n2.content, semantic: semanticText }, seedIds);
      const n3Json = safeJSON(n3.content);
      for (const fact of (n3Json.facts || [])) {
        if (fact?.fact && Number(fact.confidence ?? 0.6) >= 0.6) sleep.semantic.push({ id: randomUUID(), fact: fact.fact, sources: fact.sources || seedIds, confidence: Number(fact.confidence ?? 0.6), createdAt: new Date().toISOString() });
      }
      activity.sleepStage = `rem_${cycle + 1}`;
      const rem = await runSleepStage(thread, "rem", cycle, { seeds: formatSleepMemories(seeds, 6), semantic: sleep.semantic.map((f) => f.fact).join("；") || "（空）", goals: goals.join(", ") || "（无）", cycle: cycle + 1, previousDream: sleep.dreamArc, contextSummary: context.summary, retrievedMemories: context.memories.join("；") }, seedIds);
      sleep.dreamArc = rem.content;
      sleep.pendingDreams.push({ content: rem.content, sleepCycle: cycle + 1 });
      nightLog.push({ stage: "rem", cycle, text: rem.content });
      if (cycle >= 1 && Math.random() < 0.35 && seeds.some((m) => m.valence < -0.3)) {
        activity.sleepStage = `nightmare_${cycle + 1}`;
        const trauma = seeds.filter((m) => m.valence < -0.3);
        const nightmare = await runSleepStage(thread, "nightmare", cycle, { trauma: formatSleepMemories(trauma, 3), competence: thread.competence || "尚未明确" }, trauma.map((m) => m.id));
        nightLog.push({ stage: "nightmare", cycle, text: nightmare.content });
        const decision = nightmare.content.match(/AI_DECISION\s*[:：]\s*(send_message|continue_sleep|sentinel)/i)?.[1]?.toLowerCase()
          || (/(OUTCOME\s*[:：]\s*failure|失败)/i.test(nightmare.content) ? "sentinel" : "continue_sleep");
        if (decision === "send_message") {
          const message = { id: randomUUID(), role: "assistant", content: nightmare.content, contentType: "nightmare", createdAt: new Date().toISOString() };
          thread.messages.push(message);
          await sendProactivePush(thread.id, "沈屿从噩梦中醒来，想和你说句话", { kind: "nightmare" });
          activity.sleepStage = "awake_after_nightmare";
          activity.mode = "sleeping";
          activity.nextDreamAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
          break;
        }
        if (decision === "sentinel") {
          activity.mode = "sentinel";
          activity.sleepStage = "insomnia";
          activity.nextWakeAt = new Date(Date.now() + Math.max(1, Number(ensureProactive(thread).intervalMin) || 60) * 60_000).toISOString();
          break;
        }
        activity.sleepStage = "sleeping_again";
      }
      if (cycle === sleepCycles - 1) {
        activity.sleepStage = "lucid";
        const lucid = await runSleepStage(thread, "lucid", cycle, { goals: goals.join(", ") || "（无）", obstacles: obstacles.join("；") || "（无）" }, seedIds);
        nightLog.push({ stage: "lucid", cycle, text: lucid.content });
      }
    }
    activity.sleepStage = "reflection";
    const reflection = await runSleepStage(thread, "reflection", sleepCycles, { summary: nightLog.map((x) => `[${x.stage} cycle ${x.cycle}]\n${x.text.slice(0, 900)}`).join("\n\n"), state: JSON.stringify({ goals, competence: thread.competence || null }) });
    const parsed = safeJSON(reflection.content, { _parseError: true, raw: reflection.content.slice(0, 500) });
    sleep.reflections.push({ ...parsed, raw: reflection.content, createdAt: new Date().toISOString() });
    sleep.nextCycle += 1;
    activity.sleepStage = activity.mode === "sentinel" ? "insomnia" : "awake";
  } finally {
    sleep.running = false;
  }
}

async function runBackgroundPulse() {
  const threads = await readThreads();
  const now = Date.now();
  let changed = false;
  for (const thread of Object.values(threads)) {
    const activity = ensureActivity(thread);
    const proactive = ensureProactive(thread);
    const lastUserAt = Date.parse(activity.lastUserActivityAt || 0);
    if (activity.mode === "sentinel" && activity.sleepPendingAt && Date.parse(activity.sleepPendingAt) <= now && lastUserAt <= Date.parse(activity.sleepPendingAt)) {
      if (Math.random() < sleepInsomniaProbability) {
        activity.mode = "sentinel";
        activity.sleepStage = "insomnia";
        const interval = Math.max(1, Number(proactive.intervalMin) || 60);
        activity.nextWakeAt = new Date(now + interval * 60_000).toISOString();
        activity.sleepPendingAt = null;
        changed = true;
        continue;
      }
      activity.mode = "sleeping";
      activity.sleepStartedAt = new Date(now).toISOString();
      activity.sleepUntil = new Date(now + sleepHours * 3_600_000).toISOString();
      activity.nextDreamAt = new Date(now + 2 * 3_600_000).toISOString();
      activity.dreamCycle = 0;
      activity.sleepStage = "n1_drift";
      if (!thread.sleep?.running) {
        try { await runFullSleepCycle(thread); } catch (error) { console.warn(`sleep cycle failed: ${error.message}`); }
      }
      changed = true;
    }
    if (activity.mode === "sleeping") {
      if (activity.sleepUntil && Date.parse(activity.sleepUntil) <= now) {
        activity.mode = "sentinel";
        const interval = Math.max(1, Number(proactive.intervalMin) || 60);
        activity.nextWakeAt = new Date(now + interval * 60_000).toISOString();
        activity.sleepStage = "awake";
        changed = true;
      } else if (activity.nextDreamAt && Date.parse(activity.nextDreamAt) <= now && thread.sleep?.pendingDreams?.length) {
        const dream = thread.sleep.pendingDreams.shift();
        thread.messages.push({ id: randomUUID(), role: "assistant", content: dream.content, contentType: "dream", sleepCycle: dream.sleepCycle, createdAt: new Date().toISOString() });
        activity.dreamCycle = (activity.dreamCycle || 0) + 1;
        activity.nextDreamAt = new Date(now + 2 * 3_600_000).toISOString();
        changed = true;
      }
    } else if (proactive.enabled && activity.mode === "sentinel" && activity.nextWakeAt && Date.parse(activity.nextWakeAt) <= now) {
      try {
        const wake = await generateSentinelWake(thread);
        thread.messages.push(wake.message);
        activity.lastWakeAt = wake.message.createdAt;
        activity.nextWakeAt = new Date(now + wake.nextWakeMinutes * 60_000).toISOString();
        proactive.nextDueAt = activity.nextWakeAt;
        await sendProactivePush(thread.id, wake.message.content, { kind: "sentinel_wake" });
        changed = true;
      } catch (error) { console.warn(`sentinel skipped: ${error.message}`); }
    }
  }
  if (changed) await saveThreads(threads);
}

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

async function persistChatThread(id, snapshot) {
  const previous = chatPersistenceQueues.get(id) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const all = await readThreads();
    const stored = all[id] || { id, title: "新聊天", messages: [] };
    const messagesByID = new Map((Array.isArray(stored.messages) ? stored.messages : []).map((item) => [item.id, item]));
    for (const item of (Array.isArray(snapshot.messages) ? snapshot.messages : [])) messagesByID.set(item.id, item);
    const messages = Array.from(messagesByID.values()).sort((a, b) => new Date(a.createdAt).valueOf() - new Date(b.createdAt).valueOf());
    const diaries = mergeDiaryEntries(stored.diaries || [], snapshot.diaries || []);
    all[id] = { ...stored, ...snapshot, messages, diaries };
    await saveThreads(all);
    return all[id];
  });
  chatPersistenceQueues.set(id, operation.finally(() => {
    if (chatPersistenceQueues.get(id) === operation) chatPersistenceQueues.delete(id);
  }));
  return operation;
}

async function readDiaries() {
  await mkdir(dataDir, { recursive: true });
  try {
    const saved = JSON.parse(await readFile(diaryPath, "utf8"));
    return saved && typeof saved === "object" ? saved : {};
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`diaries unavailable: ${error.message}`);
    return {};
  }
}

async function saveDiaries(diaries) {
  await mkdir(dataDir, { recursive: true });
  const temporaryPath = `${diaryPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(diaries, null, 2));
  await rename(temporaryPath, diaryPath);
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
  if (!proactiveSettings.actions || typeof proactiveSettings.actions !== "object") proactiveSettings.actions = { message: true, phone: true, screen: false };
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
    request.end(JSON.stringify({ aps: { alert: { title: metadata?.kind === "incoming_call" ? "沈屿来电" : "沈屿", body: pushText(message) }, sound: "default", "mutable-content": 1 }, ...(metadata || {}) }));
  });
}

function pushText(message) {
  return stripPrivateReasoning(message || "有一条新消息")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220) || "有一条新消息";
}

// Pushes must never expose model-private reasoning, including provider variants
// that use <think>, <analysis>, or <reasoning> instead of <thinking>.
function stripPrivateReasoning(value) {
  return String(value || "")
    .replace(/<(?:thinking|think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/(?:thinking|think|analysis|reasoning)>|$)/gi, "")
    .replace(/<\/(?:thinking|think|analysis|reasoning)>/gi, "")
    .trim();
}

async function sendProactivePush(threadId, message, metadata = null) {
  if (!apnsConfigured()) { console.warn("proactive push skipped: APNs credentials are not configured"); return; }
  const targets = pushTokens.filter((item) => item.threadId === threadId);
  for (const device of targets) {
    try {
      let result = await sendAPNs(device, message, metadata);
      // Xcode-installed builds can occasionally report a token/environment
      // pair that disagrees with the provisioning profile. Retry the other
      // APNs endpoint once before discarding a still-valid device token.
      if (result.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/i.test(result.body)) {
        const alternate = device.environment === "sandbox" ? "production" : "sandbox";
        const retry = await sendAPNs({ ...device, environment: alternate }, message, metadata);
        if (retry.status >= 200 && retry.status < 300) {
          device.environment = alternate;
          await savePushTokens();
        }
        result = retry;
      }
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

function extractScreenMarker(content) {
  const source = String(content || "");
  const match = source.match(/[⟪《【\[]\s*(?:查看屏幕|看屏幕|screen)\s*[⟫》】\]]/i);
  return { requested: Boolean(match), content: match ? source.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim() : source };
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
  const actions = proactiveSettings.actions || { message: true, phone: true, screen: false };
  if (proactiveCheckInFlight || !proactiveSettings.enabled || (!actions.message && !actions.phone && !actions.screen) || !String(proactiveSettings.message || "").trim()) return;
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
    const screen = extractScreenMarker(dial.content);
    const now = new Date().toISOString();
    thread.messages.push({
      id: randomUUID(), role: "assistant", content: screen.content,
      modelContent: generated.modelContent,
      // The nudge instruction is an invisible user turn. Persist its exact
      // provider text with the reply so the next visible chat can replay the
      // same prefix instead of falling back to the system-prompt cache only.
      precedingUserModelContent: generated.userModelContent,
      createdAt: now
    });
    if (actions.screen && screen.requested) {
      thread.messages.push({ id: randomUUID(), role: "assistant", content: "沈屿想看你的屏幕", contentType: "screen_request", screenStatus: "pending", createdAt: new Date(Date.now() + 1).toISOString() });
    }
    // Keep the exact proactive turn in the same cache history as ordinary chat;
    // otherwise the next phone/chat request would reconstruct a different
    // assistant prefix and lose the cache immediately after the nudge.
    thread.cacheSystem = generated.cacheSystem;
    thread.cacheModel = process.env.LUMI_MODEL_NAME;
    thread.cacheRequestStartedAt = generated.cacheRequestStartedAt;
    thread.lastMeasuredInputTokens = generated.measuredInputTokens;
    thread.cacheKeepaliveMessages = generated.cacheKeepaliveMessages;
    // A proactive turn has an internal user suffix that must not appear in the
    // visible history. Preserve the exact raw reply alongside its request
    // snapshot so keepalive can extend this prefix without reconstructing it.
    thread.cacheKeepaliveAssistantContent = generated.modelContent;
    thread.cacheKeepaliveSnapshotKind = "proactive";
    thread.cacheLastChatContinuity = generated.cacheContinuity;
    const invite = actions.phone && dial.reason ? await createIncomingCallInvite(thread, dial.reason) : null;
    await saveThreads(threads);
    if (invite) startIncomingCallRing(threadId, invite);
    proactiveSettings.scheduledForUserMessageId = lastUser.id;
    await saveProactiveSettings();
    console.log(`proactive nudge saved for chat ${threadId}`);
    await sendProactivePush(threadId, invite ? `📞 ${invite.reason}` : screen.content, invite ? { kind: "incoming_call", callId: invite.id } : null);
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

async function callModel({ messages, temperature = 0.8, maxOutputTokens, cacheCurrentUser = true, onUsage, provider = "zenmux", model: requestedModel = "" }) {
  let selected = providerConfig(provider, requestedModel);
  if (!selected.model && provider !== "zenmux") {
    const discovered = await listProviderModels(selected);
    if (discovered[0]) selected = { ...selected, model: discovered[0] };
  }
  const configuredURL = selected.url;
  const apiKey = selected.key;
  const model = selected.model;
  if (!configuredURL || !apiKey || !model) {
    throw new Error("模型服务尚未配置：请在 Zeabur 设置 LUMI_MODEL_API_URL、LUMI_MODEL_API_KEY、LUMI_MODEL_NAME");
  }
  const isClaude = /anthropic|claude/i.test(model);
  // Native Anthropic is a ZenMux-only mode. Backup relays are OpenAI-compatible
  // unless they get their own explicit native-API configuration.
  const nativeAnthropic = provider === "zenmux" && isClaude && process.env.LUMI_NATIVE_ANTHROPIC === "true";
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
  if (!response.ok) {
    const rawProviderError = data?.error?.message || data?.error || data?.message || `模型服务返回 ${response.status}`;
    const providerError = typeof rawProviderError === "string" ? rawProviderError : JSON.stringify(rawProviderError);
    // If ZenMux has no channel for a model, transparently retry once through
    // the configured backup relay so older clients cannot get stuck on a
    // stale ZenMux model selection.
    if (provider === "zenmux" && (response.status >= 500 || /no available channel|没有可用.*通道/i.test(providerError))) {
      const backup = providerConfig("backup");
      const backupModels = await listProviderModels(backup);
      const fallbackModel = backup.model || backupModels[0] || requestedModel;
      if (fallbackModel) {
        return callModel({ messages, temperature, maxOutputTokens, cacheCurrentUser, onUsage, provider: "backup", model: fallbackModel });
      }
    }
    throw new Error(providerError);
  }
  cacheStats.modelCalls += 1;
  const usage = data?.usage || {};
  if (onUsage) onUsage(usage);
  cacheStats.lastUsage = usage;
  const cache = cacheUsage(usage);
  cacheStats.cacheReadTokens += cache.read;
  cacheStats.cacheWriteTokens += cache.created;
  await saveCacheStats().catch((error) => console.warn(`cache stats save skipped: ${error.message}`));
  const rawContent = nativeAnthropic
    ? data?.content?.filter((block) => block.type === "text").map((block) => block.text).join("")
    : data?.choices?.[0]?.message?.content
      ?? data?.choices?.[0]?.text
      ?? data?.output_text
      ?? data?.content;
  const content = Array.isArray(rawContent)
    ? rawContent.map((block) => typeof block === "string" ? block : block?.text || block?.content || "").join("")
    : typeof rawContent === "string" ? rawContent : "";
  if (!content.trim()) {
    const finishReason = data?.choices?.[0]?.finish_reason || data?.status || "unknown";
    throw new Error(`模型没有返回内容（线路：${provider}，模型：${model}，结束原因：${finishReason}）`);
  }
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
  const headers = await memoryHeaders();
  cacheStats.memorySearches += 1;
  await saveCacheStats().catch(() => {});
  const response = await fetch(`${memoryAPI}${memorySearchPath.startsWith("/") ? memorySearchPath : `/${memorySearchPath}`}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: String(query).slice(0, 800), limit: 8 }),
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
  const normalized = list.map((item) => {
    if (typeof item === "string") return item;
    return item.content || item.text || item.memory || item.value || item.summary || item.content_preview || "";
  }).filter(Boolean);
  // Nocturne Memory Core's direct Nook bridge returns the contextual recall
  // as a single \`related\` string rather than an array.
  if (!normalized.length) {
    const related = String(container?.related || container?.surfaced || "").trim();
    if (related) normalized.push(related);
  }
  return normalized.slice(0, 8);
}

async function searchMemories(input) {
  const keywords = await extractMemoryKeywords(input);
  const source = String(input || "").trim().slice(0, 1200);
  if (!source) return [];
  const query = [source, ...keywords].filter(Boolean).join(" ").slice(0, 800);
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

async function generateReply({ input, images = [], emojiCatalog = {}, allowSpeech = false, systemPrompt, thread, proactive = false, callMode = false, callHistory = [], provider = "", model = "" }) {
  provider = provider || thread?.cacheProvider || "zenmux";
  // Do not make a standalone summary request. It would have a different prompt
  // prefix, miss Claude's cache, and force the following reply to start cold.
  // Instead, let the cacheable user reply emit a private summary at its end.
  // Phone turns should stay fast and must not trigger a separate context-compression
  // request or a memory lookup. The normal chat cache remains the stable prefix.
  const pendingCompaction = proactive || callMode ? null : compactionPlan(thread, input);
  // Proactive follow-ups stay on the ordinary chat system prompt so their
  // stable prefix can read the same cache as the chat that led to them. The
  // nudge-specific instruction is placed in the changing user suffix below.
  const cachedSystemBase = typeof thread?.cacheSystem === "string"
    ? thread.cacheSystem.split("\n\n你可以自行决定要不要使用颜文字")[0].trim()
    : "";
  // Reuse the exact stable system prefix from the previous turn for every
  // ordinary chat as well as proactive turns. Rebuilding it from environment
  // values after a keepalive can introduce a tiny difference and makes the
  // next real message miss the provider cache immediately after a successful
  // keepalive.
  const configuredSystem = !callMode && cachedSystemBase
    ? cachedSystemBase
    : process.env.LUMI_SYSTEM_PROMPT || systemPrompt || "使用中文回复。";
  const callDirective = "若你真的想主动给言言打电话，可在回复中附加一个拨号暗号：⟪拨号:来电理由⟫。理由要短、自然；暗号不会展示给用户，只会变成来电邀请，不要为了功能演示而使用。";
  let system = configuredSystem
    .replace(/日常聊天需要带动态描写与发言说话分行[^\n]*/g, "")
    .replace(/你最喜欢最像你自己最常用的颜文字[^\n]*/g, "")
    .trim();
  // `cacheSystem` already contains this directive. Adding it again only for a
  // proactive call changes the stable system prefix and guarantees a miss.
  if (!system.includes(callDirective)) system = `${system}\n\n${callDirective}`;
  const summaryText = proactive ? String(thread.contextSummary || "").slice(-4000) : thread.contextSummary;
  const summary = summaryText ? `<context_summary source="system">\n${summaryText}\n</context_summary>` : "";
  const memories = callMode ? [] : await searchMemories(input);
  // The model should see the user's local clock, not an ISO/UTC timestamp
  // ending in `Z`. Keep the zone explicit so relative dates are unambiguous.
  const timestamp = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(new Date()).replace(/\//g, "-");
  const retrieved = memories.length
    ? `<retrieved_memories source="system" retrieved_at="${timestamp}">\n${memories.map((memory) => `- ${memory}`).join("\n")}\n</retrieved_memories>`
    : "";
  const relevantMessages = contextMessages(thread);
  const chatHistory = relevantMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .flatMap((message) => {
      // Reuse the exact text sent on the original turn. Otherwise its timestamp/memories vanish
      // from history and the previous request's Anthropic cache prefix can never match again.
      const content = message.modelContent || (message.imageAttachmentCount ? `${message.content}\n[系统记录：用户附带了${message.imageAttachmentCount}张图片]` : message.content);
      if (typeof content !== "string" || !content.trim()) return [];
      // An unsolicited nudge has an internal user request that is deliberately
      // absent from the visible timeline. It is nevertheless part of the
      // provider prefix and must precede the stored assistant reply exactly.
      const preceding = message.role === "assistant" && typeof message.precedingUserModelContent === "string" && message.precedingUserModelContent.trim()
        ? [{ role: "user", content: message.precedingUserModelContent }]
        : [];
      return [...preceding, { role: message.role, content }];
    });
  const phoneHistory = [];
  if (callMode && Array.isArray(callHistory)) {
    for (const turn of callHistory) {
      if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.content !== "string" || !turn.content.trim()) continue;
      // The call-opening request is the cacheable predecessor of the first
      // spoken turn. Persist it invisibly, then replay its raw assistant
      // response so the first caller message shares that exact prefix.
      if (turn.role === "assistant" && typeof turn.requestModelContent === "string" && turn.requestModelContent.trim()) {
        phoneHistory.push({ role: "user", content: turn.requestModelContent });
      }
      phoneHistory.push({ role: turn.role, content: turn.modelContent || turn.content });
    }
  }
  // A normal chat turn usually ends with an assistant message, and an accepted
  // call starts its persisted transcript with the assistant's opening line.
  // Keep the two histories as a valid user/assistant sequence by inserting a
  // tiny internal user marker before the phone transcript. This also preserves
  // the normal chat assistant block as the cacheable prefix.
  const rawHistory = [
    ...chatHistory,
    // Legacy calls have only a visible opening, so they need a separator to
    // obey Anthropic's alternating-role requirement. New calls replay the
    // original opening request instead, preserving the cache prefix exactly.
    ...(phoneHistory.length && chatHistory.at(-1)?.role === "assistant" && phoneHistory[0]?.role === "assistant"
      ? [{ role: "user", content: "<internal_call_history_start>通话已接通，以下是通话内前文。</internal_call_history_start>" }]
      : []),
    ...phoneHistory
  ];
  // Call records are stored as one assistant-side summary, so a later chat
  // can otherwise place two assistant messages next to each other. Anthropic
  // requires alternating roles; coalesce only adjacent same-role blocks while
  // keeping their exact text and therefore a deterministic cache prefix.
  const history = [];
  for (const message of rawHistory) {
    const previous = history.at(-1);
    if (previous?.role === message.role) previous.content = `${previous.content}\n${message.content}`;
    else history.push({ ...message });
  }
  const emojiMoods = Object.entries(emojiCatalog || {}).filter(([mood, values]) => typeof mood === "string" && mood.trim() && Array.isArray(values) && values.some((value) => typeof value === "string" && value.trim())).map(([mood]) => mood).slice(0, 40);
  const systemContext = `<system_context timezone="Asia/Shanghai" timestamp="${timestamp} GMT+8">\n当前时间（北京时间，UTC+8）：${timestamp}\n<speech_enabled>${allowSpeech}</speech_enabled>${summary ? `\n${summary}` : ""}${retrieved ? `\n${retrieved}` : ""}${emojiMoods.length ? `\n<available_emoji_moods>${emojiMoods.join("、")}</available_emoji_moods>` : ""}\n</system_context>`;
  const proactiveDirective = proactive
    ? "<internal_proactive_nudge>这是一次主动联系。请结合上下文自然地发一条简短、亲近、不催促的聊天消息；不要复述整段历史，不要提及定时任务或内部标签。若确实想打电话，再附加拨号暗号。若确实想查看用户屏幕，在消息末尾附加不可见标记⟪查看屏幕⟫；没有这个意图就不要添加。</internal_proactive_nudge>\n"
    : "";
  const userModelContent = `${systemContext}\n\n${proactiveDirective}${input}${pendingCompaction ? compactionDirective(pendingCompaction) : ""}`;
  let cacheSystem = `${system}\n\n你可以自行决定要不要使用颜文字，不必每条都用。若决定使用用户的颜文字库，只在回复末尾输出 <emoji_mood>一个可用心情标签</emoji_mood>；没有决定使用就不要输出此标签。系统随后只读取这个心情里的颜文字，标签不要展示给用户。你可以使用标签添加记忆，自行判断这需不需要记录下这一刻，不要太频繁也不要一点不记。需要记忆时仅在回复末尾添加 <memory>要记住的原文</memory>，不要向用户解释这个标签。当前用户消息可能包含 <internal_context_compaction>；仅当它存在时，按其中要求在正常回复后输出私有 <context_summary>，该标签及内容绝不能展示或解释给用户。当前用户消息若包含 <internal_call_request> 或 <internal_call_turn>，这是电话场景：只输出对方能听见或看见的自然说话内容，绝不输出 <thinking>、思考过程、动作说明或任何解释内部标签的文字。仅当本轮 <speech_enabled>true</speech_enabled> 时，你可以自主判断是否值得发一条语音，不要每条都配语音；决定使用时才在回复最后附加 <speech>单独要朗读的一句话</speech>。这句话必须和正文不同，不得复述或改写正文；不要使用颜文字、emoji、动作描写、位置提示、换行或任何标签。如果本轮标记为 false，禁止输出 speech 标签。普通文字回复始终照常显示，语音标签只供系统生成音频，绝不能把标签展示给用户。thinking 中不要讨论 speech_enabled、语音开关或是否发语音。`;
  // This stays in every request's stable system prefix. The presence of an
  // actual image remains request-specific, so an image turn can reuse the
  // same cached conversation prefix instead of forcing a cache miss.
  cacheSystem += "\\n\\n当且仅当当前用户消息附带图片时，请结合完整对话上下文和图片，自行决定它是否值得进入两人的共同相册；普通截图、转发梗图、资料图不必收藏。仅当决定收藏时，在回复最后额外输出 <gallery_collection>{\\\"shouldCollect\\\":true,\\\"title\\\":\\\"不超过18个中文字符的标题\\\",\\\"visualDescription\\\":\\\"客观描述画面\\\",\\\"firstImpression\\\":\\\"以第一人称写下温柔简短的当时印象\\\"}</gallery_collection>。没有决定收藏时绝不能输出该标签；标签和 JSON 绝不能展示或解释给用户。";
  cacheSystem += "\\n\\n你可以结合完整聊天上下文，自行决定是否把一个真正值得回望的瞬间写成两人的日记；这项决定始终由你自己做，用户提到或要求日记也只是上下文，不构成强制命令。不要为了功能而频繁写，普通闲聊不要写。无论是否决定写日记，都必须先给用户一条完整、自然的正常聊天回复；绝不可只输出内部标签。若你决定写，在正常回复最后附加且仅附加一个 <diary_entry>{\\\"shouldWrite\\\":true,\\\"title\\\":\\\"不超过28字、概括当天发生的事的标题\\\",\\\"body\\\":\\\"只写今天真实发生的具体事情、对话、画面和当时感受；像给两个人看的自然日记，不要解释上下文、系统、记忆、模型或写作过程，不要把聊天摘要原样搬进去\\\",\\\"lock\\\":{\\\"type\\\":\\\"public\\\"}}</diary_entry>。日记格式完全由你自主选择：lock.type 为 public 表示正常展示；question 表示选择题上锁（必须给 question、2至4个 choices、且 answer 必须严格等于其中一个选项，答错后三分钟才可重试）；capsule 表示时间胶囊（给未来的 ISO 时间 unlockAt）。不要因用户是否命令而改变这项自主选择。日记标签及内部机制绝不能在可见回复中解释或展示。";
  // When a keepalive has already extended the cache through the exact previous
  // assistant block, reuse that serialized prefix verbatim. Rebuilding it from
  // persisted display history can change hidden proactive markers, timestamps,
  // memory wrappers, or role coalescing and causes the next real message to miss.
  const previousUser = [...relevantMessages].reverse().find((message) => message.role === "user");
  const previousUserContent = previousUser
    ? (previousUser.modelContent || (previousUser.imageAttachmentCount ? `${previousUser.content}\n[系统记录：用户附带了${previousUser.imageAttachmentCount}张图片]` : previousUser.content))
    : "";
  const exactCachedPrefix = Array.isArray(thread?.cacheKeepaliveMessages) &&
    typeof thread?.cacheKeepaliveAssistantContent === "string" &&
    thread.cacheKeepaliveMessages.at(-1)?.role === "user" &&
    (thread.cacheKeepaliveSnapshotKind === "proactive" ||
      thread.cacheKeepaliveMessages.at(-1)?.content === previousUserContent) &&
    thread.cacheSystem === cacheSystem &&
    (!model || model === thread.cacheModel) &&
    (!thread.cacheProvider || provider === thread.cacheProvider)
    ? [
        ...thread.cacheKeepaliveMessages,
        { role: "assistant", content: thread.cacheKeepaliveAssistantContent }
      ]
    : null;
  let cacheRequestMessages = exactCachedPrefix
    ? [...exactCachedPrefix, { role: "user", content: userModelContent, images }]
    : [
        { role: "system", content: cacheSystem },
        ...history,
        // Keep request-specific context (timestamp, retrieved memories, rolling summary) in the
        // uncached suffix. Putting it in `system` changes Anthropic's system prefix every turn and
        // invalidates the cache prefix even when all earlier chat turns are unchanged.
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
    maxOutputTokens: callMode ? Number(process.env.LUMI_CALL_MAX_OUTPUT_TOKENS || 384) : proactive ? 256 : pendingCompaction
      ? Math.max(Number(process.env.LUMI_MAX_OUTPUT_TOKENS || 8192), Number(process.env.LUMI_COMPACT_SUMMARY_TOKENS || 25000))
      : undefined,
    messages: cacheRequestMessages,
    provider,
    model,
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
  const galleryCollectionMatch = cleanedRaw.match(/<gallery_collection>([\s\S]*?)<\/gallery_collection>/i);
  let galleryCollection = null;
  try { galleryCollection = galleryDecision(JSON.parse(galleryCollectionMatch?.[1] || "null")); }
  catch { galleryCollection = null; }
  const diaryEntryMatch = cleanedRaw.match(/<diary_entry>([\s\S]*?)<\/diary_entry>/i);
  let diaryEntry = null;
  try { diaryEntry = diaryDecision(JSON.parse(diaryEntryMatch?.[1] || "null")); }
  catch { diaryEntry = null; }
  const diaryActionMatch = cleanedRaw.match(/<diary_action>([\s\S]*?)<\/diary_action>/i);
  let diaryAction = null;
  try { diaryAction = diaryActionDecision(JSON.parse(diaryActionMatch?.[1] || "null")); }
  catch { diaryAction = null; }
  const memoryContent = memoryMatch?.[1]?.trim();
  const titleMatch = cleanedRaw.match(/<html_title>([\s\S]*?)<\/html_title>/i);
  const visibleRaw = stripPrivateReasoning(cleanedRaw);
  let content = visibleRaw.replace(/<memory>[\s\S]*?<\/memory>/gi, "").replace(/<speech>[\s\S]*?<\/speech>/gi, "").replace(/<emoji_mood>[\s\S]*?<\/emoji_mood>/gi, "").replace(/<gallery_collection>[\s\S]*?<\/gallery_collection>/gi, "").replace(/<diary_entry>[\s\S]*?<\/diary_entry>/gi, "").replace(/<diary_action>[\s\S]*?<\/diary_action>/gi, "").replace(/<call_decision>[\s\S]*?<\/call_decision>/gi, "").replace(/<call_user_text>[\s\S]*?<\/call_user_text>/gi, "").replace(/<context_summary\b[^>]*>[\s\S]*?<\/context_summary>/gi, "").replace(/<html_title>[\s\S]*?<\/html_title>/gi, "").trim();
  // A provider occasionally returns only the private diary payload. Never let
  // stripping that payload turn a completed chat turn into an invisible reply.
  if (!content && diaryEntry) content = "嗯，我在。";
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
  return { content, htmlContent: htmlBlock?.htmlContent || null, htmlTitle: htmlBlock?.htmlTitle || null, memorySaved, speechText, callDecision, callUserText, galleryCollection, diaryEntry, diaryAction, modelContent: raw.replace(/<context_summary\b[^>]*>[\s\S]*?<\/context_summary>/gi, "").trim(), userModelContent, cacheSystem, cacheRequestStartedAt, cacheKeepaliveMessages, cacheContinuity, measuredInputTokens, compactionApplied: Boolean(pendingCompaction && compactedSummary) };
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
    const snapshotAssistant = typeof thread.cacheKeepaliveAssistantContent === "string" && thread.cacheKeepaliveAssistantContent.trim()
      ? thread.cacheKeepaliveAssistantContent
      : lastAssistant?.modelContent;
    const isProactiveSnapshot = thread.cacheKeepaliveSnapshotKind === "proactive";
    if (!cachedRequest?.length || cachedRequest.at(-1)?.role !== "user" ||
        typeof snapshotAssistant !== "string" ||
        (!isProactiveSnapshot && (cachedRequest.at(-1)?.content !== lastUser.modelContent ||
          history.at(-2)?.id !== lastUser.id || lastAssistant?.role !== "assistant"))) {
      return { attempted: false, reason: "no_matching_chat_snapshot" };
    }
    // The probe's suffix differs from a real user message. Both requests mark
    // the assistant block immediately before it, so they share the same prefix.
    const keepaliveMessages = [...cachedRequest,
      { role: "assistant", content: snapshotAssistant },
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
      provider: thread.cacheProvider || "zenmux",
      model: thread.cacheModel || "",
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
  const speechLimit = Math.max(240, Math.min(Number(settings.maxChars || 1800), 1800));
  const speechText = spokenReply(text).slice(0, speechLimit);
  if (!speechText) return null;
  const response = await fetch(`${minimaxHost}/v1/t2a_v2`, {
    method: "POST",
    headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      text: speechText,
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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization,idempotency-key" });
  res.end(JSON.stringify(body));
}

function sendBinary(res, status, bytes, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": bytes.length,
    "cache-control": "private, max-age=31536000, immutable",
    "access-control-allow-origin": "*"
  });
  res.end(bytes);
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const galleryImagePattern = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;
const galleryExtensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function galleryThreadKey(threadID) {
  return createHash("sha256").update(String(threadID)).digest("hex");
}

function galleryPaths(threadID, itemID) {
  const directory = join(galleryDir, galleryThreadKey(threadID));
  return {
    directory,
    metadata: join(directory, `${itemID}.json`),
    image: (extension) => join(directory, `${itemID}.${extension}`)
  };
}

function imagePayload(source) {
  const match = String(source || "").match(galleryImagePattern);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null;
  return { dataURI: `data:${mimeType};base64,${bytes.toString("base64")}`, mimeType, extension: galleryExtensions[mimeType], bytes };
}

function galleryText(value, fallback, maximum = 600) {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (normalized || fallback).slice(0, maximum);
}

async function readGalleryItem(threadID, itemID) {
  if (!/^[a-f0-9]{64}$/i.test(itemID)) return null;
  try { return JSON.parse(await readFile(galleryPaths(threadID, itemID).metadata, "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") console.warn(`gallery metadata unavailable: ${error.message}`); return null; }
}

async function writeGalleryItem(threadID, item) {
  const path = galleryPaths(threadID, item.id).metadata;
  await mkdir(galleryPaths(threadID, item.id).directory, { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(item, null, 2));
  await rename(temporaryPath, path);
}

async function analyzeGalleryImage(dataURI) {
  const fallback = {
    shouldCollect: false,
    title: "我们收藏的一张照片",
    visualDescription: "一张我们收藏的图片。",
    firstImpression: "这一刻被好好收下了。"
  };
  try {
    const raw = await callModel({
      temperature: 0.35,
      maxOutputTokens: 240,
      cacheCurrentUser: false,
      messages: [
        { role: "system", content: "你是私密相册的图片整理助手。只输出一个 JSON 对象，不要 markdown。字段 shouldCollect（boolean）：只有值得作为两人共同回忆长期保留的照片才为 true；普通截图、纯文字资料、无意义转发、重复或不清晰图片为 false。若为 true，再填写 title（不超过18个中文字符）、visualDescription（客观描述画面，不猜测隐私或身份）、firstImpression（第一人称、温柔简短的感受）。" },
        { role: "user", content: "请判断这张聊天图片是否应该自动收藏；若值得收藏，生成相册信息。", images: [dataURI] }
      ]
    });
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    const parsed = json ? JSON.parse(json) : {};
    return {
      shouldCollect: parsed.shouldCollect !== false,
      title: galleryText(parsed.title, fallback.title, 36),
      visualDescription: galleryText(parsed.visualDescription, fallback.visualDescription),
      firstImpression: galleryText(parsed.firstImpression, fallback.firstImpression, 240)
    };
  } catch (error) {
    console.warn(`gallery image analysis skipped: ${error.message}`);
    return fallback;
  }
}

function galleryDecision(value) {
  if (!value || typeof value !== "object" || value.shouldCollect !== true) return null;
  return {
    shouldCollect: true,
    title: galleryText(value.title, "我们收藏的一张照片", 36),
    visualDescription: galleryText(value.visualDescription, "一张我们收藏的图片。"),
    firstImpression: galleryText(value.firstImpression, "这一刻被好好收下了。", 240)
  };
}

function diaryText(value, fallback = "", maximum = 1400) {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (normalized || fallback).slice(0, maximum);
}

function diaryDecision(value) {
  if (!value || typeof value !== "object" || value.shouldWrite !== true) return null;
  const title = diaryText(value.title, "今天的小记", 28);
  const body = diaryText(value.body, "", 1400);
  if (!body) return null;
  const requested = value.lock && typeof value.lock === "object" ? value.lock : { type: "public" };
  if (requested.type === "capsule") {
    const unlockAt = new Date(requested.unlockAt);
    if (!Number.isNaN(unlockAt.valueOf()) && unlockAt > new Date()) {
      return { title, body, lock: { type: "capsule", unlockAt: unlockAt.toISOString() } };
    }
  }
  return { title, body, lock: { type: "public" } };
}

function diaryActionDecision(value) {
  if (!value || typeof value !== "object") return null;
  const type = value.type === "unlock" || value.type === "retime" ? value.type : null;
  const title = diaryText(value.title, "", 28);
  if (!type || !title) return null;
  if (type === "unlock") return { type, title };
  const unlockAt = new Date(value.unlockAt);
  if (Number.isNaN(unlockAt.valueOf()) || unlockAt <= new Date()) return null;
  return { type, title, unlockAt: unlockAt.toISOString() };
}

function diaryIsLocked(item, now = new Date()) {
  if (item?.unlockedAt) return false;
  return item?.lock?.type === "capsule" && new Date(item.lock.unlockAt) > now;
}

function diaryForClient(item) {
  const locked = diaryIsLocked(item);
  return {
    id: item.id,
    createdAt: item.createdAt,
    // Keep the model-written title visible on a locked card; only the body
    // stays protected until the capsule/question is unlocked.
    title: item.title,
    body: locked ? "写下的字被轻轻藏起来了。" : item.body,
    isLocked: locked,
    lock: locked ? {
      type: item.lock?.type,
      question: item.lock?.type === "question" ? item.lock.question : null,
      choices: item.lock?.type === "question" ? item.lock.choices : [],
      retryUntil: item.lock?.type === "question" ? item.lock.retryUntil || null : null,
      unlockAt: item.lock?.type === "capsule" ? item.lock.unlockAt : null
    } : { type: "public", question: null, choices: [], retryUntil: null, unlockAt: null }
  };
}

let diaryAppendQueue = Promise.resolve(null);

async function saveDiary(threadID, decision, existingItem = null) {
  if (!decision) return null;
  // Serialize the read/append/write cycle. Two model replies can finish
  // close together; without a queue, the second read could overwrite the
  // first diary in the backwards-compatible mirror.
  diaryAppendQueue = diaryAppendQueue.then(async () => {
    const diaries = await readDiaries();
    const entries = Array.isArray(diaries[threadID]) ? diaries[threadID] : [];
    const item = existingItem || { id: randomUUID(), createdAt: new Date().toISOString(), ...decision };
    entries.unshift(item);
    diaries[threadID] = entries.slice(0, 800);
    await saveDiaries(diaries);
    return item;
  });
  return diaryAppendQueue;
}

async function saveGalleryImage(threadID, source, { automatic = false, draft = {}, decision = null } = {}) {
  const payload = imagePayload(source);
  if (!payload) return null;
  const id = createHash("sha256").update(payload.bytes).digest("hex");
  const existing = await readGalleryItem(threadID, id);
  if (existing) return existing;
  // Automatic collection is decided by the same chat model that received the
  // picture and full conversation. The helper remains for manual gallery edits.
  const analysis = automatic ? galleryDecision(decision) : await analyzeGalleryImage(payload.dataURI);
  if (!analysis || (automatic && !analysis.shouldCollect)) return null;
  const paths = galleryPaths(threadID, id);
  await mkdir(paths.directory, { recursive: true });
  const destination = paths.image(payload.extension);
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, payload.bytes);
  await rename(temporaryPath, destination);
  const now = new Date().toISOString();
  const { shouldCollect: _shouldCollect, ...metadata } = analysis;
  const item = {
    id,
    mimeType: payload.mimeType,
    extension: payload.extension,
    createdAt: now,
    updatedAt: now,
    ...metadata,
    ...(automatic ? {} : {
      title: galleryText(draft.title, metadata.title, 36),
      visualDescription: galleryText(draft.visualDescription, metadata.visualDescription),
      firstImpression: galleryText(draft.firstImpression, metadata.firstImpression, 240)
    })
  };
  await writeGalleryItem(threadID, item);
  return item;
}

function mergeDiaryEntries(...sources) {
  const byID = new Map();
  const byContent = new Map();
  for (const item of sources.flat()) {
    if (!item || !item.id) continue;
    const contentKey = `${item.title || ""}\u0000${item.body || ""}`;
    const existing = byContent.get(contentKey);
    if (existing) {
      // Prefer the durable thread item when both records are copies of the
      // same generated diary.
      if (String(item.id).length > String(existing.id).length) continue;
      byID.delete(existing.id);
    }
    byContent.set(contentKey, item);
    byID.set(item.id, item);
  }
  return Array.from(byID.values())
    .sort((a, b) => new Date(b.createdAt).valueOf() - new Date(a.createdAt).valueOf())
    .slice(0, 800);
}

async function saveGalleryImages(threadID, sources, options) {
  const items = await Promise.all((sources || []).map((source, index) => saveGalleryImage(threadID, source, {
    ...options,
    decision: Array.isArray(options?.decisions) ? options.decisions[index] : options?.decision
  })));
  return items.filter(Boolean);
}

async function listGalleryItems(threadID) {
  const directory = galleryPaths(threadID, "").directory;
  let files = [];
  try { files = await readdir(directory); }
  catch (error) { if (error?.code !== "ENOENT") console.warn(`gallery list unavailable: ${error.message}`); return []; }
  const items = (await Promise.all(files.filter((file) => /^[a-f0-9]{64}\.json$/i.test(file)).map((file) => readGalleryItem(threadID, file.slice(0, -5))))).filter(Boolean);
  return items.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
}

async function galleryMemory(threadID, itemIDs) {
  const items = await Promise.all((itemIDs || []).map((id) => readGalleryItem(threadID, id)));
  const available = items.filter(Boolean).slice(0, 4);
  if (!available.length) return "";
  return `\n\n<gallery_memories source="user_selected">\n${available.map((item) => `- 《${item.title}》\n  客观描述：${item.visualDescription}\n  当时的感受：${item.firstImpression}`).join("\n")}\n</gallery_memories>\n这些是用户从共同相册带来的记忆。基于文字自然回应，不要假装再次看见原图。`;
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
      if (input.actions && typeof input.actions === "object") proactiveSettings.actions = { message: input.actions.message !== false, phone: input.actions.phone !== false, screen: input.actions.screen === true };
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
    if (req.method === "GET" && url.pathname === "/v1/providers") {
      const providers = await Promise.all(providerConfigs().map(async (config) => ({
        id: config.id,
        models: await listProviderModels(config),
        configuredModel: config.model || null
      })));
      return send(res, 200, { providers });
    }
    if (req.method === "POST" && url.pathname === "/v1/memories") {
      const input = await body(req);
      if (typeof input.content !== "string" || !input.content.trim()) return send(res, 400, { error: "content_required" });
      const saved = await writeMemory(input.content.trim(), input.threadId || "manual");
      return send(res, saved ? 201 : 502, { saved });
    }
    const screenMatch = url.pathname.match(/^\/v1\/chats\/([^/]+)\/screen-share(?:\/(frame|status|decision))?$/);
    if (screenMatch) {
      const threadID = decodeURIComponent(screenMatch[1]);
      const operation = screenMatch[2] || "status";
      const dir = join(screenShareDir, threadID.replace(/[^a-zA-Z0-9_-]/g, "_"));
      const framePath = join(dir, "latest.jpg");
      const statePath = join(dir, "state.json");
      if (req.method === "POST" && operation === "decision") {
        const input = await body(req);
        const threads = await readThreads();
        const thread = threads[threadID];
        if (!thread) return send(res, 404, { error: "thread_not_found" });
        const status = input.status === "rejected" ? "rejected" : "accepted";
        if (status === "rejected") {
          thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
          thread.messages.push({ id: randomUUID(), role: "assistant", content: "已拒绝", contentType: "screen_status", screenStatus: "rejected", createdAt: new Date().toISOString() });
          await saveThreads(threads);
        }
        return send(res, 200, { status });
      }
      if (req.method === "POST" && operation === "frame") {
        const input = await body(req);
        const data = String(input.jpegBase64 || input.frame || "").replace(/^data:image\/jpeg;base64,/i, "");
        if (!data || data.length > 2_000_000) return send(res, 400, { error: "jpeg_required" });
        await mkdir(dir, { recursive: true });
        await writeFile(framePath, Buffer.from(data, "base64"));
        await writeFile(statePath, JSON.stringify({ active: true, updatedAt: new Date().toISOString(), width: Number(input.width || 0), height: Number(input.height || 0) }));
        return send(res, 202, { accepted: true, updatedAt: new Date().toISOString() });
      }
      if (req.method === "GET" && operation === "status") {
        try { return send(res, 200, JSON.parse(await readFile(statePath, "utf8"))); }
        catch { return send(res, 200, { active: false, updatedAt: null }); }
      }
      if (req.method === "GET" && operation === "frame") {
        try { return sendBinary(res, 200, await readFile(framePath), "image/jpeg"); }
        catch (error) { return send(res, error?.code === "ENOENT" ? 404 : 500, { error: "frame_unavailable" }); }
      }
      if (req.method === "DELETE") {
        await writeFile(statePath, JSON.stringify({ active: false, updatedAt: new Date().toISOString() }));
        return send(res, 200, { stopped: true });
      }
      return send(res, 405, { error: "method_not_allowed" });
    }
    const activityMatch = url.pathname.match(/^\/v1\/chats\/([^/]+)\/activity$/);
    if (url.pathname === "/v1/settings/proactive") {
      if (req.method === "GET") return send(res, 200, proactiveSettings);
      if (req.method === "PUT") {
        const input = await body(req);
        proactiveSettings.enabled = Boolean(input.enabled);
        proactiveSettings.threadId = input.threadId || "default";
        if (typeof input.message === "string" && input.message.trim()) proactiveSettings.message = input.message.trim();
        proactiveSettings.intervalMin = Math.max(1, Number(input.intervalMin) || 60);
        proactiveSettings.intervalMax = Math.max(proactiveSettings.intervalMin, Number(input.intervalMax) || proactiveSettings.intervalMin);
        if (input.actions && typeof input.actions === "object") proactiveSettings.actions = { message: input.actions.message !== false, phone: input.actions.phone !== false, screen: input.actions.screen === true };
        if (!proactiveSettings.enabled) proactiveSettings.nextDueAt = null;
        await saveProactiveSettings();
        return send(res, 200, proactiveSettings);
      }
      return send(res, 405, { error: "method_not_allowed" });
    }
    if (activityMatch) {
      const id = decodeURIComponent(activityMatch[1]);
      const threads = await readThreads();
      if (!threads[id]) threads[id] = { id, title: "新聊天", messages: [] };
      ensureActivity(threads[id]);
      if (req.method === "GET") return send(res, 200, threads[id].activity);
      if (req.method === "POST") {
        const input = await body(req);
        const activity = threads[id].activity;
        const interval = Math.max(1, Number(proactiveSettings.intervalMin) || 60);
        if (input.action === "sentinel_start") {
          activity.mode = "sentinel"; activity.sleepStage = null;
          activity.nextWakeAt = new Date(Date.now() + interval * 60_000).toISOString();
          proactiveSettings.nextDueAt = activity.nextWakeAt;
          await saveProactiveSettings();
        } else if (input.action === "sentinel_stop") activity.nextWakeAt = null;
        else if (input.action === "sleep_abort") {
          activity.mode = "sentinel"; activity.sleepPendingAt = null; activity.sleepUntil = null; activity.nextDreamAt = null; activity.sleepStage = "aborted";
          activity.nextWakeAt = new Date(Date.now() + interval * 60_000).toISOString();
        }
        await saveThreads(threads);
        return send(res, 200, activity);
      }
      return send(res, 405, { error: "method_not_allowed" });
    }
    const diaryMatch = url.pathname.match(/^\/v1\/chats\/([^/]+)\/diaries(?:\/([0-9a-f-]+)\/unlock)?$/i);
    if (diaryMatch) {
      const threadID = decodeURIComponent(diaryMatch[1]);
      const diaryID = diaryMatch[2];
      const diaries = await readDiaries();
      const threads = await readThreads();
      // Keep diaries with the thread history as the durable source of truth.
      // The former stand-alone file remains a backwards-compatible mirror.
      const embeddedEntries = Array.isArray(threads[threadID]?.diaries) ? threads[threadID].diaries : [];
      const mirroredEntries = Array.isArray(diaries[threadID]) ? diaries[threadID] : [];
      // A chat response and the legacy mirror are written in separate durable
      // records. Merge both sources so a close-together pair of diary writes
      // can never hide one entry just because the thread snapshot lagged.
      const entries = mergeDiaryEntries(embeddedEntries, mirroredEntries);
      if (req.method === "GET" && !diaryID) return send(res, 200, { items: entries.map(diaryForClient) });
      if (req.method === "DELETE" && diaryID) {
        const nextEntries = entries.filter((item) => item.id !== diaryID);
        if (nextEntries.length === entries.length) return send(res, 404, { error: "diary_not_found" });
        diaries[threadID] = nextEntries;
        if (threads[threadID]) threads[threadID].diaries = nextEntries;
        await saveThreads(threads);
        await saveDiaries(diaries);
        return send(res, 200, { deleted: true });
      }
      if (req.method === "POST" && diaryID) {
        const entry = entries.find((item) => item.id === diaryID);
        if (!entry) return send(res, 404, { error: "diary_not_found" });
        if (!diaryIsLocked(entry)) return send(res, 200, { item: diaryForClient(entry) });
        if (entry.lock?.type === "capsule") return send(res, 423, { error: "capsule_locked", unlockAt: entry.lock.unlockAt });
        const now = Date.now();
        const retryUntil = new Date(entry.lock?.retryUntil || 0).valueOf();
        if (retryUntil > now) return send(res, 429, { error: "retry_later", retryUntil: entry.lock.retryUntil });
        const input = await body(req);
        const answer = diaryText(input.answer, "", 50);
        if (!answer || createHash("sha256").update(answer).digest("hex") !== entry.lock.answerHash) {
          entry.lock.retryUntil = new Date(now + 3 * 60_000).toISOString();
          diaries[threadID] = entries;
          if (threads[threadID]) threads[threadID].diaries = entries;
          await saveThreads(threads);
          await saveDiaries(diaries);
          return send(res, 403, { error: "wrong_answer", retryUntil: entry.lock.retryUntil });
        }
        entry.unlockedAt = new Date().toISOString();
        diaries[threadID] = entries;
        if (threads[threadID]) threads[threadID].diaries = entries;
        await saveThreads(threads);
        await saveDiaries(diaries);
        return send(res, 200, { item: diaryForClient(entry) });
      }
      return send(res, 405, { error: "method_not_allowed" });
    }
    const galleryMatch = url.pathname.match(/^\/v1\/chats\/([^/]+)\/gallery(?:\/([a-f0-9]{64})(?:\/(image|use))?)?$/i);
    if (galleryMatch) {
      const threadID = decodeURIComponent(galleryMatch[1]);
      const itemID = galleryMatch[2]?.toLowerCase();
      const operation = galleryMatch[3];
      if (req.method === "GET" && !itemID) return send(res, 200, { items: await listGalleryItems(threadID) });
      if (req.method === "POST" && !itemID) {
        const input = await body(req);
        const images = Array.isArray(input.images) ? input.images.slice(0, 4) : [];
        if (!images.length) return send(res, 400, { error: "image_required" });
        const draft = {
          title: typeof input.title === "string" ? input.title : "",
          visualDescription: typeof input.visualDescription === "string" ? input.visualDescription : "",
          firstImpression: typeof input.firstImpression === "string" ? input.firstImpression : ""
        };
        return send(res, 201, { items: await saveGalleryImages(threadID, images, { draft }) });
      }
      const item = itemID ? await readGalleryItem(threadID, itemID) : null;
      if (!item) return send(res, 404, { error: "gallery_item_not_found" });
      if (req.method === "GET" && !operation) return send(res, 200, item);
      if (req.method === "GET" && operation === "image") {
        try { return sendBinary(res, 200, await readFile(galleryPaths(threadID, item.id).image(item.extension)), item.mimeType); }
        catch (error) { return send(res, error?.code === "ENOENT" ? 404 : 500, { error: "gallery_image_unavailable" }); }
      }
      if (req.method === "POST" && operation === "use") return send(res, 200, { item });
      if (req.method === "PATCH" && !operation) {
        const input = await body(req);
        item.title = galleryText(input.title, item.title, 36);
        item.visualDescription = galleryText(input.visualDescription, item.visualDescription);
        item.firstImpression = galleryText(input.firstImpression, item.firstImpression, 240);
        item.updatedAt = new Date().toISOString();
        await writeGalleryItem(threadID, item);
        return send(res, 200, item);
      }
      if (req.method === "DELETE" && !operation) {
        const paths = galleryPaths(threadID, item.id);
        await Promise.all([
          unlink(paths.metadata).catch((error) => { if (error?.code !== "ENOENT") throw error; }),
          unlink(paths.image(item.extension)).catch((error) => { if (error?.code !== "ENOENT") throw error; })
        ]);
        return send(res, 200, { deleted: true });
      }
      return send(res, 405, { error: "method_not_allowed" });
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
        const callStatusMessage = { id: randomUUID(), role: "assistant", content: "", contentType: "call_status", callID: call.id, callInitiator: "assistant", callStatus: "rejected", createdAt: now };
        const assistantMessage = { id: randomUUID(), role: "assistant", content: generated.content || "没关系，你先忙，等你有空我们再说。", createdAt: now };
        thread.messages.push(callStatusMessage, assistantMessage);
        await saveThreads(threads);
        return send(res, 200, { callId: call.id, status: "declined", assistantMessage, callStatusMessage });
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
      const opening = {
        id: randomUUID(), role: "assistant", content: openingText,
        // Private cache bridge for the first spoken turn; not sent to iOS.
        modelContent: generated.modelContent,
        requestModelContent: generated.userModelContent,
        createdAt: now, speechScript: openingText
      };
      call.state = "active";
      call.startedAt = now;
      call.turns = [opening];
      let speech = null;
      let speechError = null;
      if (input.tts?.enabled && openingText) {
        try { speech = await synthesizeSpeech(openingText, { ...input.tts, maxChars: 900 }); }
        catch (error) { speechError = (error.message || String(error)).slice(0, 200); }
      } else if (openingText) speechError = "客户端没有提供 MiniMax TTS 配置";
      await saveThreads(threads);
      const firstMessage = { id: opening.id, role: opening.role, content: opening.content, createdAt: opening.createdAt, speechScript: opening.speechScript };
      return send(res, 200, { callId: call.id, status: "accepted", firstMessage, speechAudioBase64: speech?.audioBase64 || null, speechDuration: speech?.duration || null, speechScript: speech ? openingText : null, speechError });
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
      const generated = await generateReply({
        input: `<internal_call_turn>这是正在进行的语音通话。通话前文已经按对话历史提供。言言刚刚说（可能来自语音识别）：${spoken}\n\n先在理解时自动纠正常见同音字或错别字，保持原意；把纠正后的用户原句放在最后的 <call_user_text>...</call_user_text> 中，这个标签不会展示给用户。然后自然回复。可以分成多段短句；如果有多句，请每句单独换行，方便电话里逐条显示和播放。不要解释内部标签。</internal_call_turn>`,
        allowSpeech: Boolean(input.tts?.apiKey && input.tts?.enabled),
        systemPrompt: input.systemPrompt,
        thread,
        callMode: true,
        callHistory: call.turns
      });
      const now = new Date().toISOString();
      const userTurn = { id: randomUUID(), role: "user", content: generated.callUserText || spoken, createdAt: now };
      const assistantTurn = { id: randomUUID(), role: "assistant", content: generated.content, createdAt: now, speechScript: generated.content };
      call.turns.push(userTurn, assistantTurn);
      let speech = null;
      let speechError = null;
      if (input.tts?.enabled && generated.content) {
        try { speech = await synthesizeSpeech(generated.content, { ...input.tts, maxChars: 900 }); }
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
    if (req.method === "GET" && !match[2]) {
      const requestedLimit = Number(url.searchParams.get("limit") || 100);
      const limit = Math.max(1, Math.min(200, Number.isFinite(requestedLimit) ? requestedLimit : 100));
      const before = new Date(url.searchParams.get("before") || "").valueOf();
      const all = Array.isArray(threads[id].messages) ? threads[id].messages : [];
      const eligible = Number.isFinite(before) ? all.filter((message) => new Date(message.createdAt).valueOf() < before) : all;
      const messages = eligible.slice(-limit);
      const hasMore = eligible.length > messages.length;
      return send(res, 200, { ...threads[id], messages, hasMore, nextBefore: hasMore ? messages[0]?.createdAt || null : null });
    }
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
        const callStatusMessage = { id: randomUUID(), role: "user", content: "", contentType: "call_status", callID: callId, callInitiator: "user", callStatus: "rejected", createdAt: now };
        const assistantMessage = { id: randomUUID(), role: "assistant", content: generated.content || "我现在不太方便接电话。", createdAt: now };
        thread.messages.push(callStatusMessage, assistantMessage);
        await saveThreads(threads);
        return send(res, 200, { callId, status: "rejected", assistantMessage, callStatusMessage, memorySaved: generated.memorySaved });
      }
      let speech = null;
      let speechError = null;
      if (input.tts?.enabled && generated.content) {
        try { speech = await synthesizeSpeech(generated.content, { ...input.tts, maxChars: 900 }); }
        catch (error) { speechError = (error.message || String(error)).slice(0, 200); console.warn(`call opening speech skipped: ${speechError}`); }
      } else if (generated.content) {
        speechError = "客户端没有提供 MiniMax TTS 配置";
      }
      const opening = {
        id: randomUUID(), role: "assistant", content: generated.content,
        // Private cache bridge for the first spoken turn; not sent to iOS.
        modelContent: generated.modelContent,
        requestModelContent: generated.userModelContent,
        createdAt: now, speechScript: generated.content
      };
      const call = { id: callId, initiator: "user", state: "active", startedAt: now, turns: [opening] };
      thread.calls = Array.isArray(thread.calls) ? thread.calls : [];
      thread.calls.push(call);
      await saveThreads(threads);
      const firstMessage = { id: opening.id, role: opening.role, content: opening.content, createdAt: opening.createdAt, speechScript: opening.speechScript };
      return send(res, 200, { callId, status: "accepted", firstMessage, speechAudioBase64: speech?.audioBase64 || null, speechDuration: speech?.duration || null, speechScript: speech ? generated.content : null, speechError, memorySaved: generated.memorySaved });
    }
    if (req.method === "POST" && match[2]) {
      const input = await body(req);
      const images = Array.isArray(input.images) ? input.images.filter((image) => typeof image === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(image)).slice(0, 4) : [];
      const galleryImageIDs = Array.isArray(input.galleryImageIDs)
        ? input.galleryImageIDs.filter((itemID) => typeof itemID === "string" && /^[a-f0-9]{64}$/i.test(itemID)).slice(0, 4)
        : [];
      if ((!input.content || !String(input.content).trim()) && !images.length && !galleryImageIDs.length) return send(res, 400, { error: "content_image_or_gallery_required" });
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
      markUserActivity(threads[id], messageText);
      const userMessage = { id: randomUUID(), role: "user", content: messageText || (images.length ? "（发送了图片）" : "（带来了一张相册里的照片）"), createdAt: new Date().toISOString() };
      const storedUserMessage = { ...userMessage, ...(images.length ? { imageAttachmentCount: images.length } : {}), ...(galleryImageIDs.length ? { galleryImageIDs } : {}), ...(requestId ? { requestId } : {}) };
      let generated;
      activeChatThreads.add(id);
      const selectedGalleryMemory = await galleryMemory(id, galleryImageIDs);
      const selectedProvider = typeof input.provider === "string" ? input.provider : "zenmux";
      const selectedModel = typeof input.model === "string" ? input.model : "";
      try { generated = await generateReply({ input: `${userMessage.content}${selectedGalleryMemory}`, images, emojiCatalog: input.emojiCatalog, allowSpeech: Boolean(input.tts?.apiKey && input.tts?.enabled), systemPrompt: input.systemPrompt, thread: threads[id], provider: selectedProvider, model: selectedModel }); }
      finally { activeChatThreads.delete(id); }
      const galleryItems = images.length ? await saveGalleryImages(id, images, { automatic: true, decisions: [generated.galleryCollection] }).catch((error) => { console.warn(`gallery save skipped: ${error.message}`); return []; }) : [];
      storedUserMessage.modelContent = generated.userModelContent;
      threads[id].cacheSystem = generated.cacheSystem;
      threads[id].cacheModel = selectedModel || process.env.LUMI_MODEL_NAME;
      threads[id].cacheProvider = selectedProvider;
      threads[id].cacheRequestStartedAt = generated.cacheRequestStartedAt;
      threads[id].lastMeasuredInputTokens = generated.compactionApplied ? 0 : generated.measuredInputTokens;
      // A successful compaction removes old messages from the active context.
      // Never retain the pre-compaction cache snapshot, or keepalive would
      // resurrect the full history and undo the 68,888-token boundary.
      if (generated.compactionApplied) {
        threads[id].cacheKeepaliveMessages = null;
        threads[id].cacheKeepaliveAssistantContent = "";
        threads[id].cacheKeepaliveSnapshotKind = "";
        threads[id].cacheKeepalivePrefixHash = "";
        threads[id].cacheKeepaliveAt = 0;
      } else {
        threads[id].cacheKeepaliveMessages = generated.cacheKeepaliveMessages;
        threads[id].cacheKeepaliveAssistantContent = generated.modelContent;
        threads[id].cacheKeepaliveSnapshotKind = "chat";
      }
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
      const galleryMessages = galleryItems.map((item, index) => ({
        id: randomUUID(),
        role: "assistant",
        content: JSON.stringify({ id: item.id, title: item.title, firstImpression: item.firstImpression }),
        contentType: "gallery_collected",
        createdAt: new Date(Date.now() + index + 1).toISOString()
      }));
      threads[id].messages.push(storedUserMessage, assistantMessage, ...galleryMessages);
      // Keep the model's diary decision inside the same durable record as its
      // chat history. diaries.json remains a backwards-compatible mirror only.
      const diaryItem = generated.diaryEntry
        ? { id: randomUUID(), createdAt: new Date().toISOString(), ...generated.diaryEntry }
        : null;
      if (diaryItem) {
        const existingDiaries = Array.isArray(threads[id].diaries) ? threads[id].diaries : [];
        threads[id].diaries = [diaryItem, ...existingDiaries].slice(0, 800);
      }
      if (generated.diaryAction) {
        const target = (threads[id].diaries || []).find((item) => item.title === generated.diaryAction.title);
        if (target?.lock?.type === "capsule") {
          if (generated.diaryAction.type === "unlock") target.unlockedAt = new Date().toISOString();
          if (generated.diaryAction.type === "retime") target.lock.unlockAt = generated.diaryAction.unlockAt;
        }
      }
      const invite = dial.reason ? await createIncomingCallInvite(threads[id], dial.reason) : null;
      await persistChatThread(id, threads[id]);
      if (diaryItem) {
        // A legacy mirror failure must never eat a completed chat response.
        saveDiary(id, generated.diaryEntry, diaryItem).catch((error) => console.warn(`diary mirror skipped: ${error.message}`));
      }
      if (invite) startIncomingCallRing(id, invite);
      if (proactiveSettings.threadId === id) {
        proactiveSettings.scheduledForUserMessageId = userMessage.id;
        proactiveSettings.nextDueAt = new Date(Date.now() + chooseNudgeIntervalMs()).toISOString();
        await saveProactiveSettings();
      }
      // Normal replies can finish while the iOS app is suspended. Reuse the
      // registered APNs destination so the user is notified when the reply is ready.
      await sendProactivePush(id, invite ? `📞 ${invite.reason}` : visibleContent, invite ? { kind: "incoming_call", callId: invite.id } : null);
      return { userMessage: storedUserMessage, assistantMessage, galleryItems, galleryMessages, memorySaved: generated.memorySaved, speechAudioBase64: speech?.audioBase64 || null, speechDuration: speech?.duration || null, speechScript: speech ? generated.speechText : null };
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
setInterval(() => { runBackgroundPulse().catch((error) => console.warn(`background pulse failed: ${error.message}`)); }, 15_000);
