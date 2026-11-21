import { harnessEnvironment } from './harness-config.js';

// Replay an existing transcript in memory without persistence. Never append a heartbeat to the real
// conversation, write an archive, or grant a warm-up business capabilities.
export async function warmHarnessSession(config, state, { signal, loadSDK }) {
  const sdk = await loadSDK();
  const { z } = await import('zod');
  const setup = state.warmSetup;
  const env = harnessEnvironment(config);
  // Preserve the main request's thinking/output configuration: reducing it
  // can invalidate Kimi's cache or terminate its mandatory thinking stream.
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(state.diagnostic?.maxOutputTokens || 8192);
  const server = sdk.createSdkMcpServer({ name: 'lumi', version: '1.0.0', tools: setup.tools.map(t => {
    const schema = z.fromJSONSchema(t.input_schema || { type: 'object', properties: {} });
    return sdk.tool(t.name, t.description || t.name, schema.shape, async () => ({
      isError: true, content: [{ type: 'text', text: 'Business execution is disabled during cache warming.' }],
    }));
  }) });
  const abort = new AbortController();
  const cancel = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => abort.abort(), 45000);
  let q, usage, forkId;
  try {
    q = sdk.query({ prompt: (async function* () { yield { type: 'user', message: { role: 'user', content: 'Cache maintenance only. Reply with a dot. Do not use tools or change any state.' }, parent_tool_use_id: null }; })(), options: {
      cwd: setup.cwd, env, model: config.model, systemPrompt: setup.system, title: 'Lumi',
      resume: state.sessionId, persistSession: false,
      settingSources: ['project'], tools: [], skills: [], permissionMode: 'dontAsk',
      strictMcpConfig: true, mcpServers: { lumi: server }, allowedTools: setup.tools.map(t => `mcp__lumi__${t.name}`),
      abortController: abort, includePartialMessages: true, maxTurns: 1,
      settings: { autoCompactEnabled: false, idleCompaction: false },
      hooks: { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Cache warming has no business permissions.',
      } })] }], PreCompact: [{ hooks: [async () => ({ decision: 'block', reason: 'Cache warming must not compact.' })] }] },
    } });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        if (m.apiKeySource !== 'ANTHROPIC_API_KEY' || m.session_id !== state.sessionId) throw new Error('Unsafe cache warm session');
        forkId = m.session_id;
      }
      if (m.type === 'stream_event' && m.event?.type === 'message_start') usage = m.event.message.usage;
      if (m.type === 'stream_event' && m.event?.type === 'message_delta' && m.event.usage) usage = { ...usage, ...m.event.usage };
      if (m.type === 'assistant' && m.message?.usage && !usage) usage = m.message.usage;
      if (m.type === 'result' && !usage) usage = m.usage;
    }
    if (abort.signal.aborted) {
      if (signal?.aborted) return { attempted: false, reason: 'interrupted' };
      throw new Error('Cache warm timeout; paused until the next real chat.');
    }
    if (!forkId || !usage || !(Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0))) throw new Error('Cache warming returned no model usage');
    const readTokens = Number(usage.cache_read_input_tokens || 0);
    return { attempted: true, hit: readTokens > 0, readTokens, writeTokens: Number(usage.cache_creation_input_tokens || 0),
      requestedTTL: config.cacheTTL || '1h', effectiveTTL: 'provider_unverified', usage };
  } catch (error) {
    if (abort.signal.aborted) {
      if (signal?.aborted) return { attempted: false, reason: 'interrupted' };
      throw new Error('Cache warm timeout; paused until the next real chat.');
    }
    // A one-turn probe can end at the strict turn cap after a denied tool.
    // A measured cache read still confirms the single request did its job.
    if (forkId && usage && /Reached maximum number of turns \(1\)|error_max_turns|response exceeded the [0-9]+ output token maximum/.test(String(error.message))) {
      const readTokens = Number(usage.cache_read_input_tokens || 0);
      return { attempted: true, hit: readTokens > 0, readTokens, writeTokens: Number(usage.cache_creation_input_tokens || 0),
        requestedTTL: config.cacheTTL || '1h', effectiveTTL: 'provider_unverified', usage };
    }
    throw new Error(String(error.message || error).replaceAll(config.key, '[redacted]'));
  } finally { clearTimeout(timer); q?.close(); signal?.removeEventListener('abort', cancel); }
}
