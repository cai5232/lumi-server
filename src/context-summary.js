export function isNormalModelCompletion(reason) {
  const normalized = String(reason || "").trim().toLowerCase();
  return ["stop", "end_turn", "stop_sequence", "completed"].includes(normalized);
}

export function extractCompleteContextSummary(value) {
  const source = String(value || "").trim();
  const match = source.match(/^<context_summary(?:\s+[^>]*)?>([\s\S]*?)<\/context_summary>$/i);
  const summary = match?.[1]?.trim() || "";
  return summary ? summary : null;
}
