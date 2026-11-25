// Model-only previews never enter trace JSON, chat history or request logs.
export const TOOL_IMAGES = Symbol.for('lumi.tool.images');
export function withToolImages(result, images) {
  Object.defineProperty(result, TOOL_IMAGES, { value: images, enumerable: false });
  return result;
}
export function sdkToolResponse(result) {
  const images = result?.[TOOL_IMAGES] || [];
  return { content: [{ type: 'text', text: JSON.stringify(result) }, ...images], ...(result?.isError ? { isError: true } : {}) };
}
