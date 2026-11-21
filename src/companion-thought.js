import { promptText } from "./prompt-files.js";
export const companionThoughtPrompt = promptText("companion-thought");

export function stripLegacyThoughtPrompt(content) {
  return typeof content === "string"
    ? content.replace(/\n+<character_voice>\s*(?:## 我脑子转起来的样子|在可发给对方的话之前|先让此刻|先写此刻|在正文之前)(?:(?!<\/character_voice>)[\s\S])*<\/character_voice>\s*$/i, "")
    : content;
}

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
