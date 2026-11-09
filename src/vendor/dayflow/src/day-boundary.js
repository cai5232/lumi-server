import { timestampForMessage } from './time.js';

const DEFAULT_MAX_CONVERSATION_AGE_MS = 86_400_000;

function calendarDay(value, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

export function conversationStartedAt(messages, fallback = Date.now()) {
  const timestamp = timestampForMessage(messages?.[0]);
  return timestamp ? Date.parse(timestamp) : fallback;
}

/** Recommend, but never force, a clean window after a calendar-day boundary. */
export function shouldStartFresh({
  startedAt,
  now = Date.now(),
  timeZone = 'Asia/Shanghai',
  maxAgeMs = DEFAULT_MAX_CONVERSATION_AGE_MS
} = {}) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return false;
  if (now - startedAt >= maxAgeMs) return true;
  return calendarDay(startedAt, timeZone) !== calendarDay(now, timeZone);
}
