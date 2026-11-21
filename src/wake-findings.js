import { promptText } from "./prompt-files.js";
const poem = /诗[句词篇集]?|poem/i;
const discovery = /(?:看|读|刷|翻|搜|找|遇|碰)(?:到|了)(?:一?首|一?句|一?篇|几首|这首|那首)?诗|(?:去了?|逛了?|打开了?|在).{0,12}(?:檐廊|Engawa)|\b(?:found|read|came across) (?:a |the )?poem\b/i;
const poetryTools = new Set(["daily_poem", "web_read", "rss_read", "surf_web_and_save"]);
const paragraphs = text => String(text || "").trim().split(/\n\s*\n/);
const normalized = text => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");

export const wakeFindingsPrompt = promptText("wake-findings");

export function wakeFindingFilter(messages, toolCalls) {
  const canReportNewPoem = toolCalls.some(call => call.succeeded === true && poetryTools.has(call.name));
  const earlierFindings = messages.filter(message => message.role === "assistant" && message.contentType === "sentinel")
    .slice(-12).flatMap(message => paragraphs(message.content)).filter(block => poem.test(block))
    .map(normalized);
  return text => {
    const blocks = String(text || "").split(/(\n\s*\n)/);
    const kept = blocks.filter(block => {
      if (!poem.test(block)) return true;
      if (!canReportNewPoem && discovery.test(block)) return false;
      const quotes = [...block.matchAll(/[“"「《]([^”"」》\n]+)[”"」》]/g)].map(match => normalized(match[1]));
      const excerpt = normalized(block);
      return !earlierFindings.some(previous => previous === excerpt ||
        quotes.some(quote => quote.length >= 6 && previous.includes(quote)));
    });
    return kept.length === blocks.length ? text : kept.join("").replace(/\n{3,}/g, "\n\n").trim();
  };
}
