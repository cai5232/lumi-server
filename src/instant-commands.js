import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Lumi's native implementation of the NEST countdown wire format.
export function parseInstantCommands(text = '') {
  const items = [];
  const content = String(text).replace(/<countdown\b[^>]*>([\s\S]*?)(?:<\/countdown>|$)/gi, (_, payload) => {
    try {
      const value = JSON.parse(payload.trim());
      if (typeof value?.title !== 'string' || !value.title.trim()) return '';
      const seconds = value.countdown_seconds ?? (value.minutes == null ? null : Number(value.minutes) * 60);
      if (seconds != null && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)) return '';
      if (items.length < 8) items.push({ title: value.title.trim().slice(0, 200), countdown_seconds: seconds == null ? null : Math.min(86400, Math.max(1, Math.round(seconds))) });
    } catch { /* Private malformed or unfinished tags must never reach the UI. */ }
    return '';
  }).trim();
  return { content, items };
}

export function commandFeedbackText(items) {
  if (!items.length) return '';
  return `【指令完成反馈】\n${items.map(item => {
    const elapsed = Math.round(item.duration_ms / 1000);
    const difference = item.countdown_seconds == null ? '' : `；预设 ${item.countdown_seconds} 秒，${elapsed < item.countdown_seconds ? '提前' : '超出'} ${Math.abs(elapsed - item.countdown_seconds)} 秒`;
    return `- ${JSON.stringify(item.title)}：用时 ${elapsed} 秒${difference}`;
  }).join('\n')}`;
}

export function createInstantCommandStore(directory, now = Date.now) {
  const path = join(directory, 'instant-commands.json');
  let queue = Promise.resolve();
  function transaction(operation, write = true) {
    const result = queue.then(async () => {
      let state;
      try { state = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; state = { commands: [], feedback: [] }; }
      const output = await operation(state);
      if (!write) return output;
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, path);
      return output;
    });
    queue = result.catch(() => {});
    return result;
  }
  return {
    list: threadID => transaction(state => state.commands.filter(item => item.thread_id === threadID), false),
    feedback: threadID => transaction(state => state.feedback.filter(item => item.thread_id === threadID), false),
    acknowledge: (threadID, ids) => transaction(state => {
      const consumed = new Set(ids);
      state.feedback = state.feedback.filter(item => item.thread_id !== threadID || !consumed.has(item.id));
    }),
    add: (threadID, items) => transaction(state => {
      const added = [];
      for (const item of items) {
        if (state.commands.some(old => old.thread_id === threadID && old.title === item.title && now() - old.created_at < 120000)) continue;
        if (state.commands.filter(old => old.thread_id === threadID).length >= 32) break;
        const timestamp = now();
        const command = { ...item, id: randomUUID(), thread_id: threadID, created_at: timestamp, started_at: timestamp, created_by: 'ai' };
        state.commands.push(command);
        added.push(command);
      }
      return added;
    }),
    act: (threadID, id, action) => transaction(state => {
      const item = state.commands.find(item => item.thread_id === threadID && item.id === id);
      if (!item) return null;
      if (action === 'started') return { ok: true, started_at: item.started_at };
      state.commands = state.commands.filter(candidate => candidate.id !== id);
      if (action === 'cancel') return { ok: true };
      const duration_ms = Math.max(0, now() - item.started_at);
      state.feedback.push({ ...item, duration_ms, completed_at: now() });
      return { ok: true, duration_ms };
    })
  };
}
