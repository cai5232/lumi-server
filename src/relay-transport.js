// Keep the configured protocol and credentials; adapt only explicitly rejected optional fields.
export function relayEndpoint(base, path) {
  const url = new URL(String(base).trim());
  const requested = String(path || '/chat/completions').replace(/^\/+/, '');
  let segments = url.pathname.split('/').filter(Boolean);
  if (/\/(?:chat\/completions|messages|models)\/?$/i.test(url.pathname)) {
    segments = url.pathname.replace(/\/(?:chat\/completions|messages|models)\/?$/i, '').split('/').filter(Boolean);
  }
  if (!segments.length) segments = ['v1'];
  const suffix = requested.split('/').filter(Boolean);
  let overlap = Math.min(segments.length, suffix.length);
  while (overlap > 0 && segments.slice(-overlap).join('/') !== suffix.slice(0, overlap).join('/')) overlap--;
  url.pathname = '/' + [...segments, ...suffix.slice(overlap)].join('/');
  url.hash = ''; url.search = '';
  return url.toString();
}

export function decodeRelayResponse(raw) {
  try { return JSON.parse(raw); } catch {}
  const frames = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(line => line && line !== '[DONE]').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  if (!frames.length) return { error: { message: raw.slice(0, 1000) || '中转站返回了空响应' } };
  let content = '', reasoning = '', usage = {}, stop = null;
  const calls = new Map(), blocks = new Map();
  for (const frame of frames) {
    if (frame.error || frame.type === 'error') return frame;
    if (frame.usage) usage = { ...usage, ...frame.usage };
    if (frame.message?.usage) usage = { ...usage, ...frame.message.usage };
    const choice = frame.choices?.[0];
    if (choice) {
      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === 'string') content += delta.content;
      reasoning += delta.reasoning_content || delta.reasoning || '';
      stop = choice.finish_reason || stop;
      for (const call of delta.tool_calls || []) {
        const index = call.index ?? 0, existing = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.function.name += call.function.name;
        existing.function.arguments += call.function?.arguments || '';
        calls.set(index, existing);
      }
    }
    if (frame.type === 'message_start') stop = frame.message?.stop_reason || stop;
    if (frame.type === 'content_block_start') blocks.set(frame.index, { ...frame.content_block });
    if (frame.type === 'content_block_delta') {
      const block = blocks.get(frame.index) || { type: 'text', text: '' }, delta = frame.delta || {};
      if (delta.text) block.text = (block.text || '') + delta.text;
      if (delta.thinking) block.thinking = (block.thinking || '') + delta.thinking;
      if (delta.partial_json) block.partialJSON = (block.partialJSON || '') + delta.partial_json;
      blocks.set(frame.index, block);
    }
    if (frame.type === 'message_delta') stop = frame.delta?.stop_reason || stop;
  }
  if (blocks.size) return { content: [...blocks.values()].map(block => { if (block.partialJSON) { try { block.input = JSON.parse(block.partialJSON); } catch {} delete block.partialJSON; } return block; }), stop_reason: stop, usage };
  return { choices: [{ message: { content, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.size ? { tool_calls: [...calls.values()] } : {}) }, finish_reason: stop }], usage };
}

function removeField(value, key) {
  if (!value || typeof value !== 'object') return;
  delete value[key];
  for (const item of Object.values(value)) removeField(item, key);
}
export function relayCompatibilityPatch(body, message) {
  const error = String(message).toLowerCase();
  const limit = error.match(/max_tokens\s*:\s*\d+\s*>\s*(\d+)/) || error.match(/max_tokens.{0,60}(?:less than or equal to|at most|maximum(?: is)?|<=)\s*(\d+)/);
  if (limit && Number.isFinite(body.max_tokens) && Number(limit[1]) > 0 && Number(limit[1]) < body.max_tokens) return { limit: Number(limit[1]) };
  if (!/unsupported|not support|not allowed|not permitted|unrecognized|unknown|extra inputs|extra fields|unexpected|不支持|不允许/.test(error)) return null;
  if (/cache_control|cache control|\bttl\b/.test(error)) return /\bttl\b/.test(error) ? { removeDeep: 'ttl' } : { removeDeep: 'cache_control' };
  if (/\btools?\b|tool_choice|function calling|工具/.test(error) && body.tools) return { remove: ['tools', 'tool_choice', 'mcp_servers'] };
  if (/\bthinking\b/.test(error) && body.thinking) return { remove: ['thinking'] };
  if (/\btemperature\b/.test(error) && Object.hasOwn(body,'temperature')) return { remove: ['temperature'] };
  if (/max_tokens/.test(error) && /max_completion_tokens/.test(error) && Object.hasOwn(body,'max_tokens')) return { rename: ['max_tokens','max_completion_tokens'] };
  return null;
}
function applyPatch(body, patch) {
  if (patch.limit && Number.isFinite(body.max_tokens)) body.max_tokens = Math.min(body.max_tokens, patch.limit);
  for (const key of patch.remove || []) delete body[key];
  if (patch.removeDeep) removeField(body, patch.removeDeep);
  if (patch.rename && Object.hasOwn(body,patch.rename[0])) { body[patch.rename[1]] = body[patch.rename[0]]; delete body[patch.rename[0]]; }
}
const capabilities = new Map();
export async function requestRelay({ url, headers, body, fetchImpl = fetch, timeoutMS = 150000 }) {
  const key = url + '\n' + body.model;
  const requestBody = structuredClone(body);
  for (const patch of capabilities.get(key) || []) applyPatch(requestBody, patch);
  const signal = AbortSignal.timeout(timeoutMS);
  for (let attempt=0; attempt<4; attempt++) {
    let response, raw;
    try {
      response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(requestBody), signal, redirect: 'error' });
      raw = await response.text();
    } catch (error) {
      if (signal.aborted) throw new Error('模型服务等待超过 150 秒。请稍后重试或切换线路。');
      throw new Error(`连接模型服务失败：${error.cause?.code || error.message}`);
    }
    const data = decodeRelayResponse(raw);
    const errorText = data?.error?.message || data?.error || data?.message || raw;
    const patch = [400,422].includes(response.status) && attempt < 3 ? relayCompatibilityPatch(requestBody, typeof errorText === 'string' ? errorText : JSON.stringify(errorText)) : null;
    if (patch) {
      const before = JSON.stringify(requestBody); applyPatch(requestBody, patch);
      if (before !== JSON.stringify(requestBody)) {
        const saved = capabilities.get(key) || [];
        capabilities.set(key, [...saved, patch]);
        if (capabilities.size > 128) capabilities.delete(capabilities.keys().next().value);
        continue;
      }
    }
    return { response, data, requestBody };
  }
}
