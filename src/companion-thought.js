export function readCompanionThought(value) {
  let text = null;
  const content = String(value || "").replace(
    /```[\s\S]*?(?:```|$)|<(thinking|think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<companion_thought\b[^>]*>([\s\S]*?)(<\/companion_thought\s*>|$)|\[\[\s*思考\s*[:：]?\s*([\s\S]*?)(\]\]|$)/gi,
    (block, providerTag, tagged, tagEnd, bracketed, bracketEnd) => {
      if (providerTag || block.startsWith("```")) return block;
      if ((tagEnd || bracketEnd) && !text) {
        text = (tagged ?? bracketed).replace(/<(thinking|think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
          .replace(/<[^>]*>/g, "").trim() || null;
      }
      return "";
    }
  ).trim();
  return { text, content };
}
