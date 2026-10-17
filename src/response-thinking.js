// Preserve only reasoning actually supplied by the selected upstream model.
export function responseThinking(data) {
  const message = data?.choices?.[0]?.message;
  const blocks = Array.isArray(data?.content) ? data.content : Array.isArray(message?.content) ? message.content : [];
  const field = message?.reasoning_content ?? message?.reasoning;
  const values = typeof field === 'string' ? [field] : [];
  for (const block of blocks) {
    if (/^(thinking|reasoning|analysis)$/.test(block?.type || '')) {
      const text = block.thinking ?? block.text ?? block.content;
      if (typeof text === 'string') values.push(text);
    }
  }
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].join('\n\n');
}
