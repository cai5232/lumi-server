import { timestampForMessage } from './time.js';

export function createEphemeralSlot({ name, detect, detectNote, render, maxEvents = 6 } = {}) {
  if (!name || typeof detect !== 'function') throw new TypeError('slot name and detect() are required');
  return { name, detect, detectNote, render, maxEvents };
}

const MEALS = [
  ['breakfast', /\b(breakfast)\b|(?:早饭|早餐|早上|今早).{0,18}(?:吃|喝|点|没吃|空腹)/iu],
  ['lunch', /\b(lunch)\b|(?:午饭|午餐|中午).{0,18}(?:吃|喝|点|没吃|空腹)/iu],
  ['dinner', /\b(dinner)\b|(?:晚饭|晚餐|晚上|今晚).{0,18}(?:吃|喝|点|没吃|空腹)|(?:就是).{0,18}(?:晚饭|晚餐)/iu]
];

const MEAL_QUERY = /(?:what (?:did|should|will|do) .*?(?:eat|drink)|(?:吃什么|喝什么|吃了什么|喝了什么|还记得).{0,24}(?:早饭|早餐|午饭|午餐|晚饭|晚餐|吃|喝)?)/iu;
const CONFIRMED = /(?:\bate\b|\bdrank\b|\bordered\b|\bpicked up\b|\bfinished\b|吃了|喝了|吃完|喝完|点了|下单|拿到|自取|没吃|没喝|就是.*(?:饭|餐))/iu;

export function createMealTimeline() {
  return createEphemeralSlot({
    name: 'meals', maxEvents: 6,
    detect({ text }) {
      if (MEAL_QUERY.test(text)) return { status: 'query' };
      for (const [slot, pattern] of MEALS) {
        if (pattern.test(text)) return { key: slot, text, status: CONFIRMED.test(text) ? 'confirmed' : 'candidate' };
      }
      return null;
    },
    detectNote(note) {
      if (note?.slot !== 'meals' || note?.status !== 'confirmed' || !note?.fact || !note?.sourceAt) return null;
      return { key: note.key || 'default', text: note.fact, status: 'confirmed', at: Date.parse(note.eventAt || note.sourceAt) };
    },
    render(events, { date }) {
      return [`Daily meal timeline (${date}; confirmed evidence only)`, ...events.map(e => `- ${e.key}: ${e.time} ${e.text}`)].join('\n');
    }
  });
}

function localParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date(ms));
  const get = type => parts.find(p => p.type === type)?.value;
  return { date:`${get('year')}-${get('month')}-${get('day')}`, time:`${get('hour')}:${get('minute')}` };
}

export async function applyEphemeralSlots(messages, { sourceMessages, evidenceNotes = [], slots = [], now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const today = localParts(now, timeZone).date;
  const contexts = [];
  for (const slot of slots) {
    const byKey = new Map();
    const pending = new Map();
    for (const message of sourceMessages || []) {
      if (message?.role !== 'user') continue;
      const at = timestampForMessage(message);
      if (!at || localParts(at, timeZone).date !== today) continue;
      const text = typeof message.content === 'string' ? message.content.replace(/^\s*\[(?:Now|Current time)[^\n]*\]\s*/iu, '').trim() : '';
      const event = await slot.detect({ message, text, at, now, timeZone });
      if (!event || event.status === 'query' || event.status === 'rejected') continue;
      const key = event.key || 'default';
      if (event.status === 'candidate') { pending.set(key, { ...event, at }); continue; }
      const prior = pending.get(key);
      byKey.set(key, { ...prior, ...event, text: event.text || prior?.text || text, time: localParts(event.at || at, timeZone).time });
      pending.delete(key);
    }
    if (typeof slot.detectNote === 'function') for (const note of evidenceNotes || []) {
      const event = await slot.detectNote(note, { now, timeZone });
      const at = Number(event?.at);
      if (!event || event.status !== 'confirmed' || !Number.isFinite(at) || localParts(at, timeZone).date !== today) continue;
      const key = event.key || 'default';
      byKey.set(key, { ...event, time: localParts(at, timeZone).time });
    }
    const events = [...byKey.values()].slice(-slot.maxEvents);
    if (events.length) contexts.push(slot.render ? slot.render(events, { date: today, now, timeZone }) : JSON.stringify(events));
  }
  if (!contexts.length) return { messages, slots: [] };
  const output = messages.map(m => ({ ...m }));
  const index = output.map(m => m.role).lastIndexOf('user');
  if (index >= 0 && typeof output[index].content === 'string') output[index].content += `\n\n<context source="dayflow_slots">\n${contexts.join('\n\n')}\n</context>`;
  return { messages: output, slots: contexts };
}
