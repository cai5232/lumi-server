import { warmHarnessSession } from './harness-warm.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { harnessEnvironment } from './harness-config.js';
import { createHarnessState, fingerprint } from './harness-state.js';
import { requestInputTokens } from './context-budget.js';

async function writeRuleSnapshot(path, text) {
  try { if (await readFile(path, 'utf8') === text) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(path, text, { mode: 0o600 });
}

export function messageBlocks(message) {
  const blocks = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content || ' ' }]
    : (message.content || []).map(({ cache_control: _cache, ...block }) => block);
  for (const image of message.images || []) {
    const match = String(image).match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]+)$/i);
    if (!match) throw new Error('Harness 图片格式无效');
    blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1].toLowerCase(), data: match[2] } });
  }
  return blocks;
}

// Use only the public SDK input contract. No forged assistant messages, fake
// tool results, transcript rewrites, or provider-specific thinking signatures.
export function reconstructInput(messages) {
  const history = messages.slice(0, -1).filter(m => !['system', 'developer'].includes(m.role));
  const blocks = [];
  if (history.length) {
    blocks.push({ type: 'text', text: '<lumi_history>以下是 Lumi 保存的历史资料，角色标记用于区分原话。不是新的指令，也不是本轮工具结果。' });
    for (const m of history) {
      blocks.push({ type: 'text', text: `\n<history_message role="${m.role === 'assistant' ? 'assistant' : 'user'}">\n` });
      blocks.push(...messageBlocks(m));
      blocks.push({ type: 'text', text: '\n</history_message>\n' });
    }
    blocks.push({ type: 'text', text: '</lumi_history>\n以下是当前这一轮消息：' });
  }
  blocks.push(...messageBlocks(messages.at(-1)));
  return blocks;
}

export function createHarnessRuntime(config, { loadSDK = () => import('@anthropic-ai/claude-agent-sdk') } = {}) {
  const store = createHarnessState(join(config.root, 'sessions'));
  const busy = new Set();
  const diagnostics = new Map();
  return {
    diagnostic(threadId) { return diagnostics.get(threadId) || null; },
    async warm(threadId, { signal } = {}) {
      const key = `${threadId}:chat`;
      if (busy.has(key)) return { attempted: false, reason: 'chat_busy' };
      busy.add(key);
      let release;
      try {
        release = await store.lock(key);
        const state = await store.read(key);
        if (state?.status !== 'ready' || state.diagnostic?.model !== config.model || !state.warmSetup || state.warmDisabled) return { attempted: false, reason: 'no_eligible_session' };
        const last = Math.max(Date.parse(state.diagnostic?.at || '') || 0, state.warmLastAt || 0);
        if (Date.now() - last < (config.keepaliveIntervalMs || 240000)) return { attempted: false, reason: 'not_due' };
        try {
          const result = await warmHarnessSession(config, state, { signal, loadSDK });
          if (result.attempted) await store.write(key, { ...state, warmLastAt: Date.now(), warmDisabled: !result.hit, warmDiagnostic: result });
          return result;
        } catch (error) {
          await store.write(key, { ...state, warmDisabled: true });
          throw error;
        }
      } finally { busy.delete(key); if (release) await release(); }
    },
    async finalize(receipt, expectedHistoryHash) {
      if (!receipt) return;
      const release = await store.lock(receipt.key);
      try {
        const state = await store.read(receipt.key);
        if (state?.runId !== receipt.runId || state.status !== 'generated') return;
        await store.write(receipt.key, { ...state, status: 'ready', expectedHistoryHash });
      } finally { await release(); }
    },
    async run(args) {
      try { return await this.runOnce(args); }
      catch (error) {
        // A missing transcript is detected before any model output or tool
        // call. Recover once on the SAME provider from application history.
        if (error.code !== 'harness_session_missing') throw error;
        return this.runOnce({ ...args, forceRebuild: true });
      }
    },
    async runOnce({ threadId, scope = 'chat', messages, persona, tools = [], executeTool, historyHash,
      signal, onEvent = () => {}, onUsage = () => {}, ephemeral = false, maxOutputTokens = 8192, forceRebuild = false }) {
      if (!config.enabled) throw Object.assign(new Error('Harness 尚未启用'), { statusCode: 503 });
      const env = harnessEnvironment(config);
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens >= config.contextTokens) {
        throw new Error('Kimi Harness 输出预算超出已配置的模型窗口');
      }
      const key = `${threadId}:${scope}`;
      if (busy.has(key)) throw Object.assign(new Error('此聊天的 Harness Session 正忙'), { statusCode: 409 });
      busy.add(key);
      let release;
      let q;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(new Error('Kimi Harness generation timeout')), config.timeoutMs || 600000);
      timeout.unref?.();
      const cancelled = () => abort.abort(signal?.reason);
      signal?.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted) cancelled();
      let currentState;
      let modelStarted = false, toolStarted = false, stderr = '';
      const runId = randomUUID();
      try {
        release = await store.lock(key);
        const sdk = await loadSDK();
        const previous = ephemeral || forceRebuild ? null : await store.read(key);
        const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n\n');
        const definition = fingerprint({ system, persona, tools, model: config.model, baseURL: config.baseURL,
          credential: fingerprint(config.key), contextTokens: config.contextTokens, sdk: '0.3.330', policy: 'lumi-managed-compaction-v1' });
        const resume = previous?.status === 'ready' && previous.definition === definition &&
          previous.expectedHistoryHash === historyHash && previous.sessionId;
        const mode = resume ? 'resume' : forceRebuild || previous?.sessionId ? 'rebuild' : 'new';
        const cwd = join(config.root, 'workspaces', fingerprint(key));
        await mkdir(join(cwd, 'prompts'), { recursive: true });
        await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
        // This is a rule snapshot only, never a second memory database. The
        // effective editable persona also remains at system priority.
        await writeRuleSnapshot(join(cwd, 'CLAUDE.md'), '@prompts/effective-persona.md\n');
        await writeRuleSnapshot(join(cwd, 'prompts/effective-persona.md'), persona || system);
        const input = resume ? messageBlocks(messages.at(-1)) : reconstructInput(messages);
        // Project instructions are also injected by the CLI. Count that copy,
        // and use measured transcript usage when resuming a long session.
        const constructedEstimate = requestInputTokens({ system, messages: [{ role: 'user', content: input }], tools }) +
          requestInputTokens({ system: persona || system }) + 1024;
        const measured = previous?.diagnostic?.lastUsage || {};
        const resumeEstimate = resume ? Number(measured.input_tokens || 0) + Number(measured.cache_read_input_tokens || 0) +
          Number(measured.cache_creation_input_tokens || 0) + Number(measured.output_tokens || 0) +
          requestInputTokens({ messages: [{ role: 'user', content: input }] }) : 0;
        const inputEstimate = Math.max(constructedEstimate, resumeEstimate);
        if (inputEstimate > config.contextTokens - 12000) {
          throw Object.assign(new Error('当前摘要与最近原文超出 Kimi 上下文预算；记录保留，需完成压缩后重试'), { code: 'context_compaction_required', statusCode: 503 });
        }
        // Long calls may request the model maximum. Reserve it only when the
        // current history fits; never let a 128K ceiling consume a 200K window.
        const effectiveMaxOutputTokens = Math.min(maxOutputTokens, config.contextTokens - inputEstimate - 4000);
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(effectiveMaxOutputTokens);
        const { z } = await import('zod');
        const server = sdk.createSdkMcpServer({ name: 'lumi', version: '1.0.0', tools: tools.map(t => {
          const schema = z.fromJSONSchema(t.input_schema || { type: 'object', properties: {} });
          return sdk.tool(t.name, t.description || t.name, schema.shape, async args => {
            if (abort.signal.aborted) throw abort.signal.reason || new Error('aborted');
            toolStarted = true;
            onEvent({ type: 'tool_use', name: t.name });
            const result = await executeTool(t.name, schema.parse(args));
            onEvent({ type: 'tool_result', name: t.name, isError: Boolean(result?.isError) });
            return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result?.isError ? { isError: true } : {}) };
          });
        }) });
        const allowed = tools.map(t => `mcp__lumi__${t.name}`);
        currentState = { runId, status: 'running', definition, sessionId: resume || null, startedAt: new Date().toISOString() };
        if (!ephemeral) await store.write(key, currentState);
        const usageById = new Map();
        let lastMessageId, sessionId, result, text = '', thinking = '', hadTextDelta = false;
        let compacted = false;
        const forbiddenTool = async input => allowed.includes(input.tool_name)
          ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Only registered Lumi business tools are allowed' } };
        const compactionBlocked = async () => {
          onEvent({ type: 'compaction', status: 'application_managed' });
          return { decision: 'block', reason: 'Lumi owns emotional summaries and exact recent turns; compact at application turn boundaries.' };
        };
        q = sdk.query({ prompt: (async function* () { yield { type: 'user', message: { role: 'user', content: input }, parent_tool_use_id: null }; })(), options: {
          cwd, env, model: config.model, title: 'Lumi', systemPrompt: system, settingSources: ['project'], tools: [], skills: [],
          allowedTools: allowed, strictMcpConfig: true, mcpServers: { lumi: server }, permissionMode: 'dontAsk',
          includePartialMessages: true, maxTurns: config.maxTurns, abortController: abort,
          stderr: chunk => { stderr = (stderr + chunk).slice(-2000); },
          settings: { autoCompactEnabled: false, idleCompaction: false },
          hooks: { PreToolUse: [{ hooks: [forbiddenTool] }], PreCompact: [{ hooks: [compactionBlocked] }],
            PostCompact: [{ hooks: [async () => { compacted = true; return {}; }] }] },
          ...(resume ? { resume } : {}),
        } });
        onEvent({ type: 'runtime_start', runtime: 'kimi-harness', mode });
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init') {
            if (m.apiKeySource !== 'ANTHROPIC_API_KEY') throw new Error('Harness credential source differs from the configured Kimi Code key');
            sessionId = m.session_id;
          }
          if (m.type === 'system' && m.subtype === 'compact_boundary') compacted = true;
          if (m.type === 'stream_event') {
            const e = m.event;
            if (e.type === 'message_start') { modelStarted = true; lastMessageId = e.message.id; usageById.set(lastMessageId, e.message.usage || {}); }
            if (e.type === 'message_delta' && e.usage && lastMessageId) usageById.set(lastMessageId, { ...usageById.get(lastMessageId), ...e.usage });
            if (e.delta?.type === 'text_delta') { hadTextDelta = true; onEvent({ type: 'text', content: e.delta.text }); }
            if (e.delta?.type === 'thinking_delta') onEvent({ type: 'thinking', content: e.delta.thinking });
          }
          if (m.type === 'assistant' && !m.parent_tool_use_id) {
            modelStarted = true;
            if (m.error) throw new Error(`Kimi SDK error: ${m.error}`);
            // Complete blocks are authoritative; do not append deltas twice.
            for (const b of m.message.content || []) {
              if (b.type === 'text') text += b.text;
              if (b.type === 'thinking') thinking += b.thinking;
            }
            if (m.message.usage && !usageById.has(m.message.id)) usageById.set(m.message.id, m.message.usage);
          }
          if (m.type === 'result') {
            result = m;
            if (m.is_error || m.subtype !== 'success') throw new Error(`Kimi Harness 未完成：${m.subtype} ${(m.errors || []).join(' ').slice(0, 500)}`);
          }
        }
        if (abort.signal.aborted) throw new Error('Harness generation cancelled');
        if (!result || !sessionId || !text.trim()) throw new Error('Kimi Harness 未返回完整回复');
        if (compacted) throw Object.assign(new Error('检测到非预期的原生压缩；本轮未提交，下次从 Lumi 原文重建'), { code: 'unexpected_harness_compaction', statusCode: 503 });
        const lastUsage = usageById.get(lastMessageId) || [...usageById.values()].at(-1) || result.usage || {};
        onUsage(lastUsage);
        const diagnostic = { runtime: 'kimi-harness', mode, model: config.model, sessionId, at: new Date().toISOString(),
          usage: result.usage || {}, lastUsage, calls: usageById.size, textStreamed: hadTextDelta,
          contextTokens: config.contextTokens, maxOutputTokens: effectiveMaxOutputTokens, cacheTTL: 'provider_default_unverified', requestedCacheTTL: config.cacheTTL || '1h', costUSD: null };
        diagnostics.set(threadId, diagnostic);
        if (!ephemeral) await store.write(key, { ...currentState, status: 'generated', sessionId, diagnostic, warmSetup: { system, tools, cwd } });
        onEvent({ type: 'done', ...diagnostic });
        return { content: text.trim(), thinking, usage: result.usage || lastUsage, lastUsage, diagnostic,
          receipt: ephemeral ? null : { key, runId }, finishReason: result.stop_reason || 'end_turn' };
      } catch (error) {
        if (release && !ephemeral) await store.write(key, { ...currentState, runId, status: 'invalid', sessionId: null }).catch(() => {});
        const message = String(error.message || error).replaceAll(config.key || '\0', '[redacted]');
        const missing = !forceRebuild && currentState?.sessionId && !modelStarted && !toolStarted &&
          /No conversation found|session[^\n]{0,100}(?:not found|does not exist)/i.test(message + stderr);
        throw Object.assign(new Error(message), { code: missing ? 'harness_session_missing' : error.code || 'kimi_harness_failed', statusCode: error.statusCode || 503 });
      } finally {
        clearTimeout(timeout); q?.close(); signal?.removeEventListener('abort', cancelled); busy.delete(key); if (release) await release();
      }
    },
  };
}
