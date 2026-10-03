// Behavioral port of Kelivo's world-book model, activation and prompt insertion.
// See THIRD_PARTY_NOTICES.md and LICENSES/Kelivo-AGPL-3.0.txt.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const positions = ['BEFORE_SYSTEM_PROMPT', 'AFTER_SYSTEM_PROMPT', 'TOP_OF_CHAT', 'BOTTOM_OF_CHAT', 'AT_DEPTH'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = (value, fallback, min, max) => Math.max(min, Math.min(max, Number.isInteger(value) ? value : fallback));
export function normalizeBooks(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('世界书必须是数组，最多 200 本');
  const ids = new Set();
  return value.map(book => {
    if (!book || typeof book !== 'object' || !Array.isArray(book.entries) || book.entries.length > 2000) throw new Error('世界书条目格式无效');
    const id = typeof book.id === 'string' && book.id ? book.id : randomUUID();
    if (ids.has(id)) throw new Error('世界书 ID 重复');
    ids.add(id);
    const entryIDs = new Set();
    return { id, name: String(book.name || ''), description: String(book.description || ''), enabled: book.enabled !== false,
      entries: book.entries.map(e => {
        if (!e || typeof e !== 'object') throw new Error('条目格式无效');
        const id = typeof e.id === 'string' && e.id ? e.id : randomUUID();
        if (entryIDs.has(id)) throw new Error('条目 ID 重复');
        entryIDs.add(id);
        return { id, name: String(e.name || ''), enabled: e.enabled !== false, priority: integer(e.priority, 0, -10000, 10000),
          position: positions.includes(e.position) ? e.position : 'AFTER_SYSTEM_PROMPT', content: String(e.content || ''),
          injectDepth: integer(e.injectDepth, 4, 1, 200), role: e.role === 'ASSISTANT' ? 'ASSISTANT' : 'USER',
          keywords: Array.isArray(e.keywords) ? e.keywords.map(String).map(s => s.trim()).filter(Boolean) : [],
          useRegex: e.useRegex === true, caseSensitive: e.caseSensitive === true, scanDepth: integer(e.scanDepth, 4, 1, 200),
          constantActive: e.constantActive === true, sticky: integer(e.sticky, 0, 0, 10000), cooldown: integer(e.cooldown, 0, 0, 10000), delay: integer(e.delay, 0, 0, 10000) };
      }) };
  });
}
export function matches(entry, context) {
  if (!entry.enabled) return false;
  if (entry.constantActive) return true;
  return entry.keywords.some(keyword => {
    if (entry.useRegex) { try { return new RegExp(keyword, entry.caseSensitive ? '' : 'i').test(context); } catch { return false; } }
    return entry.caseSensitive ? context.includes(keyword) : context.toLowerCase().includes(keyword.toLowerCase());
  });
}
export function evaluateBooks(books, scanMessages, history, previous = {}) {
  const count = history.length;
  const continues = previous.historyHash && previous.messageCount >= 0 && previous.messageCount <= count && previous.historyHash === hash(history.slice(0, previous.messageCount));
  const old = continues ? previous.effects || {} : {};
  const effects = {}, triggered = [];
  let seq = 0;
  for (const book of books) {
    if (!book.enabled) continue;
    for (const entry of book.entries) {
      const order = seq++;
      if (!entry.enabled || !entry.content.trim()) continue;
      const key = JSON.stringify([book.id, entry.id]);
      const signature = entry.sticky || entry.cooldown ? hash(entry) : '';
      const effect = old[key]?.signature === signature ? old[key] : null;
      let active = false;
      if (effect && effect.activatedAt <= count) {
        const elapsed = count - effect.activatedAt;
        if (elapsed <= entry.sticky) { active = true; effects[key] = effect; }
        else if (elapsed <= entry.sticky + entry.cooldown) { effects[key] = effect; continue; }
      }
      if (!active) {
        if (count < entry.delay) continue;
        const context = scanMessages.filter(m => ['user', 'assistant'].includes(m.role)).map(m => String(m.content || '').trim()).filter(Boolean).slice(-entry.scanDepth).join('\n');
        active = matches(entry, context);
        if (active && (entry.sticky || entry.cooldown)) effects[key] = { signature, activatedAt: count };
      }
      if (active) triggered.push({ entry, order });
    }
  }
  triggered.sort((a, b) => b.entry.priority - a.entry.priority || a.order - b.order);
  return { entries: triggered.map(t => t.entry), state: { messageCount: count, historyHash: Object.keys(effects).length ? hash(history) : '', effects } };
}
export function injectBooks(source, entries) {
  const messages = source.map(m => ({ ...m }));
  const group = position => entries.filter(e => e.position === position);
  const content = list => list.map(e => e.content.trim()).filter(Boolean).join('\n');
  const safe = target => { let i = Math.max(0, Math.min(messages.length, target)); while (i > 0 && messages[i]?.role === 'tool') i--; return i; };
  const merged = list => {
    const roles = new Map();
    for (const e of list) { if (!roles.has(e.role)) roles.set(e.role, []); roles.get(e.role).push(e); }
    return [...roles].map(([role, list]) => ({ role: role.toLowerCase(), content: role === 'ASSISTANT' ? content(list) : `<system>\n${content(list)}\n</system>` }));
  };
  const before = content(group('BEFORE_SYSTEM_PROMPT')), after = content(group('AFTER_SYSTEM_PROMPT'));
  if (before || after) {
    const index = messages.findIndex(m => m.role === 'system');
    if (index < 0) messages.unshift({ role: 'system', content: [before, after].filter(Boolean).join('\n') });
    else messages[index].content = [before, messages[index].content, after].filter(Boolean).join('\n');
  }
  const top = group('TOP_OF_CHAT');
  if (top.length) { const i = messages.findIndex(m => m.role === 'user'); messages.splice(safe(i < 0 ? messages.length : i), 0, ...merged(top)); }
  const bottom = group('BOTTOM_OF_CHAT');
  if (bottom.length) messages.splice(safe(messages.length - 1), 0, ...merged(bottom));
  const depths = new Map();
  for (const e of group('AT_DEPTH')) { if (!depths.has(e.injectDepth)) depths.set(e.injectDepth, []); depths.get(e.injectDepth).push(e); }
  for (const [depth, list] of [...depths].sort((a,b) => b[0] - a[0])) messages.splice(safe(messages.length - depth), 0, ...merged(list));
  return messages;
}
export class WorldBookStore {
  constructor(path) { this.path = path; this.queue = Promise.resolve(); }
  async read() { try { return JSON.parse(await readFile(this.path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { books: [], activeBookIds: [], revision: 0 }; throw e; } }
  async save(value) {
    const action = this.queue.then(async () => {
      const current = await this.read();
      if (value.revision !== current.revision) { const e = new Error('世界书已被其他设备修改，请刷新后重试'); e.status = 409; throw e; }
      const books = normalizeBooks(value.books);
      if (!Array.isArray(value.activeBookIds)) throw new Error('请选择启用的世界书');
      const ids = new Set(books.filter(b => b.enabled).map(b => b.id));
      const next = { books, activeBookIds: [...new Set(value.activeBookIds)].filter(id => ids.has(id)), revision: current.revision + 1 };
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2)); await rename(temporary, this.path);
      return next;
    });
    this.queue = action.catch(() => {}); return action;
  }
}
