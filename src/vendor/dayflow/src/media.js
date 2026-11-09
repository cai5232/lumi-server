function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
}

function isImagePart(part) {
  return part && ['image', 'image_url', 'input_image'].includes(part.type);
}

/**
 * Keep images for the newest user turn only. Older images become explicit
 * delivery receipts; they do not silently disappear and do not get resent.
 */
export function decayImages(messages, {
  receipt = '[Image delivery receipt: the image was attached and delivered in this turn; pixels are no longer in active context.]'
} = {}) {
  let newestUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') { newestUser = index; break; }
  }
  return messages.map((message, index) => {
    if (!Array.isArray(message?.content) || index === newestUser) return message;
    const hadImage = message.content.some(isImagePart);
    if (!hadImage) return message;
    const content = message.content.filter(part => !isImagePart(part));
    content.push({ type: 'text', text: receipt });
    return { ...message, content };
  });
}

export function markRecall(content, anchor) {
  return {
    role: 'user',
    content,
    metadata: { dayflow: { recalled: true, anchor } }
  };
}

export function isRecallMessage(message) {
  return message?.metadata?.dayflow?.recalled === true;
}

export function capsuleSourceText(message) {
  if (isRecallMessage(message)) return '';
  return textOf(message?.content)
    .replace(/\s*<context source="dayflow_temporal">[\s\S]*?<\/context>\s*/gi, '\n')
    .trim();
}
