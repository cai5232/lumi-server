export function removeMalformedAnthropicThinkingBlocks(messages) {
  if (!Array.isArray(messages)) return [];

  return messages.flatMap((message) => {
    if (!message || !Array.isArray(message.content)) return [message];

    const content = message.content.filter((block) =>
      !block || typeof block !== "object" || block.type !== "thinking" ||
      typeof block.thinking === "string"
    );
    if (content.length === message.content.length) return [message];
    return content.length ? [{ ...message, content }] : [];
  });
}
