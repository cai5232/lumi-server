import { resolve } from 'node:path';

export function harnessConfig(env = process.env) {
  const baseURL = String(env.LUMI_KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/');
  const url = new URL(baseURL);
  if (url.protocol !== 'https:' || !['api.kimi.com', 'api.kimi.ai'].includes(url.hostname) ||
      url.pathname.replace(/\/$/, '') !== '/coding' || url.search || url.hash || url.username || url.password) {
    throw new Error('Kimi Code Harness requires the official /coding/ endpoint');
  }
  const model = String(env.LUMI_KIMI_CODE_MODEL || 'k3');
  const contextTokens = Number(env.LUMI_KIMI_CODE_CONTEXT_TOKENS || 200000);
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 20000 || contextTokens > 1048576) {
    throw new Error('LUMI_KIMI_CODE_CONTEXT_TOKENS must be the verified model window (20000–1048576)');
  }
  const effort = String(env.LUMI_HARNESS_EFFORT || 'low');
  if (!['low', 'high', 'max'].includes(effort)) throw new Error('LUMI_HARNESS_EFFORT must be low, high or max');
  return {
    effort,
    enabled: env.LUMI_HARNESS_ENABLED === 'true',
    key: String(env.LUMI_KIMI_CODE_API_KEY || '').trim(), baseURL, model, contextTokens,
    root: resolve(env.LUMI_DATA_DIR || 'data', 'harness'),
    cacheTTL: env.LUMI_HARNESS_CACHE_TTL === '5m' ? '5m' : '1h',
    keepaliveIntervalMs: 240000,
    keepaliveMaxIdleMs: 3600000,
    maxTurns: 8,
    timeoutMs: 600000,
  };
}

// Construct a fresh child environment: no Anthropic login, alternate provider,
// proxy credentials, application secrets or API-key helper is inherited.
export function harnessEnvironment(config, source = process.env) {
  if (!config.key) throw Object.assign(new Error('Kimi Code API Key 尚未配置'), { code: 'kimi_key_missing', statusCode: 503 });
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SystemRoot']) if (source[key]) env[key] = source[key];
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: resolve(config.root, 'config'),
    ANTHROPIC_BASE_URL: config.baseURL,
    ANTHROPIC_API_KEY: config.key,
    ANTHROPIC_MODEL: config.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: config.model,
    CLAUDE_CODE_SUBAGENT_MODEL: config.model,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(config.contextTokens),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(config.contextTokens),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'lumi-server',
    CLAUDE_CODE_MAX_RETRIES: '1',
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_EFFORT_LEVEL: config.effort || 'low',
    CLAUDE_CODE_PROMPT_CACHE_TTL: config.cacheTTL || '1h',
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: config.cacheTTL || '1h',
    API_TIMEOUT_MS: '120000',
  });
  return env;
}
