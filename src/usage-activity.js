const nonnegative = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const dateKey = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'});
export function cacheInputTokens(record) {
  if (Number.isFinite(record.cacheInputTokens)) return nonnegative(record.cacheInputTokens);
  try {
    const usage = JSON.parse(record.responseJSON || '{}').usage;
    if (!usage) return null;
    if (usage.prompt_tokens != null) return nonnegative(usage.prompt_tokens);
    if (usage.input_tokens != null) return nonnegative(usage.input_tokens) + nonnegative(usage.cache_read_input_tokens) + nonnegative(usage.cache_creation_input_tokens);
  } catch {}
  return null;
}
export function usageActivity(records, now = new Date()) {
  const today = dateKey.format(now), days = new Map();
  let firstDate = today, retainedRequests = 0;
  for (const record of records) {
    const time = Date.parse(record.createdAt);
    if (!Number.isFinite(time) || time > now.getTime()) continue;
    const date = dateKey.format(new Date(time));
    firstDate = date < firstDate ? date : firstDate;
    const day = days.get(date) || {date, requests: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheInputTokens: 0, estimatedCacheRequests: 0, durationMs: 0, errors: 0};
    const input = nonnegative(record.inputTokens), output = nonnegative(record.outputTokens), cached = nonnegative(record.cachedTokens);
    const exactInput = cacheInputTokens(record), denominator = exactInput ?? Math.max(input, cached);
    day.requests++; retainedRequests++;
    day.inputTokens += input; day.outputTokens += output; day.tokens += input + output;
    day.cachedTokens += Math.min(cached, denominator); day.cacheInputTokens += denominator;
    if (exactInput === null && cached > 0) day.estimatedCacheRequests++;
    day.durationMs += nonnegative(record.durationMs);
    if (!(record.status >= 200 && record.status < 400)) day.errors++;
    days.set(date, day);
  }
  return {timeZone: 'Asia/Shanghai', generatedAt: now.toISOString(), firstDate, retainedRequests,
    days: [...days.values()].sort((a,b) => a.date.localeCompare(b.date))};
}
