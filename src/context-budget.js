// Estimate the serialized model input, including tool definitions and hidden context.
// Image data is already encoded; counting its base64 characters as text is misleading.
function textTokens(value) {
  const text = String(value || '');
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function contentTokens(value) {
  if (typeof value === 'string') return textTokens(value);
  if (Array.isArray(value)) return value.reduce((sum, block) => sum + contentTokens(block), 0);
  if (!value || typeof value !== 'object') return 0;
  if (value.type === 'image' || value.type === 'image_url') return 1600;
  if (value.type === 'tool_use') return textTokens(value.name) + textTokens(JSON.stringify(value.input || {}));
  return contentTokens(value.text ?? value.content ?? '');
}

function messageInputTokens(message) {
  return contentTokens(message.content) + textTokens(JSON.stringify(message.tool_calls || [])) + 8;
}

export function requestInputTokens(body) {
  return contentTokens(body.system) +
    (body.messages || []).reduce((sum, message) => sum + messageInputTokens(message), 0) +
    textTokens(JSON.stringify(body.tools || []));
}

// Keep a contiguous recent suffix plus every system instruction and the current
// turn. The archive and its compaction cursor are independent of this view.
export function fitChatHistory(body, limit) {
  const messages = body.messages || [];
  const isUserTurn = message => message.role === 'user' &&
    !(Array.isArray(message.content) && message.content.some(block => block?.type === 'tool_result'));
  const currentUser = messages.findLastIndex(isUserTurn);
  let tokens = requestInputTokens(body);
  if (tokens <= limit || currentUser < 0) return null;

  const dropped = new Set();
  for (let index = 0; index < currentUser; index++) {
    const message = messages[index];
    if (message.role === 'system' || message.role === 'developer') continue;
    if (tokens <= limit && isUserTurn(message)) break;
    tokens -= messageInputTokens(message);
    dropped.add(index);
  }
  if (!dropped.size || tokens > limit) return null;
  return { messages: messages.filter((_, index) => !dropped.has(index)), tokens, dropped: dropped.size };
}

export function assertChatContextBudget(body, limit, measuredInputTokens = 0) {
  const estimated = requestInputTokens(body);
  const tokens = Math.max(estimated, Number(measuredInputTokens) || 0);
  if (tokens <= limit) return;
  throw Object.assign(new Error(`上下文约 ${Math.ceil(tokens)} tokens，超过当前聊天请求的 ${limit} tokens 预算。本次请求未发送，聊天记录仍保留。`), {
    code: 'context_compaction_required', statusCode: 503
  });
}
