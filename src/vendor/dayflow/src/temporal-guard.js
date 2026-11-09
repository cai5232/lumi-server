import { timestampForMessage } from './time.js';

export const TEMPORAL_DISCIPLINE_RULE = 'Temporal discipline: calculate elapsed time from visible timestamps; advance counters, tasks, or events only after explicit user confirmation or a passed explicit deadline.';

const DEFAULT_NEGATION = /(?:no|not|isn't|wasn't|没有|没到|不到|不是|不算|哪有|并非|未到)\s*$/iu;

function contentText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function matchOnce(pattern, value) {
  const copy = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  return copy.exec(value);
}

function parseSmallInteger(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [left, right] = value.split('十');
    return (left ? digits[left] : 1) * 10 + (right ? digits[right] : 0);
  }
  return digits[value];
}

/** Create a detector for any explicitly confirmed, monotonically named counter. */
export function createConfirmedProgressDetector({
  key,
  pattern,
  contextPattern,
  negationPattern = DEFAULT_NEGATION,
  parseValue = value => Number(value),
  lookback = 16,
  maxAgeMs = 6 * 60 * 60 * 1000
}) {
  if (!key || !(pattern instanceof RegExp)) throw new TypeError('key and pattern are required');
  return ({ messages, now }) => {
    const recent = messages.slice(-lookback);
    if (contextPattern instanceof RegExp && !matchOnce(contextPattern, recent.map(contentText).join('\n'))) return null;
    for (let index = recent.length - 1; index >= 0; index--) {
      const message = recent[index];
      if (message?.role !== 'user') continue;
      const text = contentText(message);
      const match = matchOnce(pattern, text);
      if (!match) continue;
      const lead = text.slice(Math.max(0, match.index - 12), match.index);
      if (negationPattern && matchOnce(negationPattern, lead)) continue;
      const value = parseValue(match.groups?.value ?? match[1]);
      const timestamp = timestampForMessage(message);
      const confirmedAt = timestamp ? Date.parse(timestamp) : NaN;
      if (!Number.isFinite(confirmedAt) || now - confirmedAt > maxAgeMs) return null;
      if (value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return null;
      return {
        key,
        value,
        confirmedAt: new Date(confirmedAt).toISOString(),
        elapsedMinutes: Math.max(0, Math.floor((now - confirmedAt) / 60_000)),
        completion: 'unconfirmed'
      };
    }
    return null;
  };
}

export function createRoundProgressDetector(options = {}) {
  return createConfirmedProgressDetector({
    key: 'round',
    pattern: /(?:第\s*)?(?<value>\d+|[一二两三四五六七八九十]+)\s*(?:轮|rounds?)/iu,
    contextPattern: /(?:minutes?|hours?|timer|countdown|挂机|分钟|小时|倒计时|计时|刷新|进度|守(?:完|着)?|死线|截止|来得及|收工)/iu,
    parseValue: parseSmallInteger,
    ...options
  });
}

function displayMinute(value, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value)).replace(',', '');
}

function renderFacts(facts, timeZone, maxChars) {
  return facts.map(fact => {
    const at = displayMinute(fact.confirmedAt, timeZone);
    return `${fact.key}=${fact.value}@${at}; elapsed=${fact.elapsedMinutes}m; completion=${fact.completion}`;
  }).join('\n').slice(0, maxChars);
}

export function injectTemporalFacts(messages, facts, { timeZone = 'Asia/Shanghai', maxChars = 240 } = {}) {
  if (!facts?.length) return messages;
  const output = messages.map(message => ({ ...message }));
  const index = output.map(message => message?.role).lastIndexOf('user');
  if (index < 0) return messages;
  const context = `<context source="dayflow_temporal">\n${renderFacts(facts, timeZone, maxChars)}\n</context>`;
  const message = output[index];
  if (typeof message.content === 'string') message.content = `${message.content}\n${context}`;
  else if (Array.isArray(message.content)) message.content = [...message.content, { type: 'text', text: context }];
  else return messages;
  message.metadata = { ...message.metadata, dayflow: { ...message.metadata?.dayflow, temporalFacts: true } };
  return output;
}

export class TemporalGuard {
  constructor({ detectors = [], timeZone = 'Asia/Shanghai', maxFactChars = 240 } = {}) {
    if (!Array.isArray(detectors) || detectors.some(detector => typeof detector !== 'function')) {
      throw new TypeError('detectors must be an array of functions');
    }
    this.detectors = detectors;
    this.timeZone = timeZone;
    this.maxFactChars = maxFactChars;
  }

  async derive(messages, now = Date.now()) {
    const results = await Promise.all(this.detectors.map(detector => detector({ messages, now })));
    return results.flat().filter(Boolean);
  }

  async apply(messages, { sourceMessages = messages, now = Date.now() } = {}) {
    const facts = await this.derive(sourceMessages, now);
    return {
      facts,
      messages: injectTemporalFacts(messages, facts, { timeZone: this.timeZone, maxChars: this.maxFactChars })
    };
  }
}

export function createRoundProgressGuard(options = {}) {
  return new TemporalGuard({
    detectors: [createRoundProgressDetector(options.detector)],
    timeZone: options.timeZone,
    maxFactChars: options.maxFactChars
  });
}
