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

export function requestInputTokens(body) {
  return contentTokens(body.system) + (body.messages || []).reduce((sum, message) =>
    sum + contentTokens(message.content) + textTokens(JSON.stringify(message.tool_calls || [])) + 8, 0) +
    textTokens(JSON.stringify(body.tools || []));
}

export function assertChatContextBudget(body, limit, measuredInputTokens = 0) {
  const estimated = requestInputTokens(body);
  const tokens = Math.max(estimated, Number(measuredInputTokens) || 0);
  if (tokens <= limit) return;
  throw Object.assign(new Error(`上下文约 ${Math.ceil(tokens)} tokens，超过 ${limit} tokens 上限，压缩尚未成功。已暂停本次模型请求以避免继续消耗超大上下文；请检查摘要线路的额度或切换可用线路后重试。聊天记录仍保留。`), {
    code: 'context_compaction_required', statusCode: 503
  });
}
