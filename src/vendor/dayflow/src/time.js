const RELATIVE_DATE_RE = /(?:today|tonight|tomorrow|yesterday|this\s+(?:morning|afternoon|evening|week|month)|next\s+(?:week|month)|last\s+(?:night|week|month)|今天|今日|今早|今晨|今晚|明天|明早|明晚|后天|昨天|昨晚|前天|次日|本周|这周|下周|上周|本月|这个月|下月|上月)/iu;
const DAYPART_RE = /(?:morning|afternoon|evening|night|上午|中午|下午|傍晚|晚上|夜里|凌晨)/iu;
const ABSOLUTE_DAYPART_RE = /\d{4}-\d{2}-\d{2}(?:日)?\s*(?:morning|afternoon|evening|night|上午|中午|下午|傍晚|晚上|夜里|凌晨)/giu;

export function hasFloatingTime(value) {
  const text = String(value || '');
  if (RELATIVE_DATE_RE.test(text)) return true;
  return DAYPART_RE.test(text.replace(ABSOLUTE_DAYPART_RE, ''));
}

export function validTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

export function normalizeTimestamp(value) {
  if (value == null || value === '') return undefined;
  if (!validTimestamp(value)) throw new TypeError(`Invalid timestamp: ${value}`);
  return value;
}

export function isPast(value, now = Date.now()) {
  return validTimestamp(value) && Date.parse(value) < now;
}

export function timestampForMessage(message) {
  if (validTimestamp(message?.createdAt)) return message.createdAt;
  if (Number.isFinite(message?.time)) return new Date(message.time).toISOString();
  const text = typeof message?.content === 'string' ? message.content : '';
  const transport = text.match(/\[Now:\s*(\d{4}-\d{2}-\d{2})\s+[A-Za-z]{3}\s+(\d{2}:\d{2})\s+UTC\+8\]/i);
  if (transport) return new Date(`${transport[1]}T${transport[2]}:00+08:00`).toISOString();
  const match = text.match(/\[(?:Now|当前时间):\s*(\d{4}-\d{2}-\d{2}(?:[ T][^\]]+)?)\]/i);
  if (!match || Number.isNaN(Date.parse(match[1]))) return undefined;
  return match[1];
}
