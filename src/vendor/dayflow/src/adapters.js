function cleanMessages(messages) {
  return messages.filter(message => message?.role && message.content != null);
}

export function anthropicRequest({ model, system, messages, maxTokens = 4096, ...rest }) {
  return {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: cleanMessages(messages),
    ...rest
  };
}

export function openAIRequest({ model, system, messages, maxTokens = 4096, ...rest }) {
  return {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...cleanMessages(messages)
    ],
    max_completion_tokens: maxTokens,
    ...rest
  };
}

/** OpenRouter accepts the OpenAI chat-completions message shape. */
export function openRouterRequest(options) {
  return openAIRequest(options);
}
