import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Independent, atomic, optimistic updates; no thread/session/cache mutation.
export function editablePrompt(dataDir, name, fallback) {
  const path = join(dataDir, `${name}.json`);
  let pending = Promise.resolve();
  const snapshot = prompt => ({ prompt, revision: createHash('sha256').update(prompt).digest('hex') });
  const read = async () => {
    try { const saved = JSON.parse(await readFile(path, 'utf8')); if (typeof saved.prompt !== 'string') throw Error('invalid_saved_prompt'); return saved.prompt; }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  };
  return { read, snapshot, save(prompt, revision) {
    const operation = pending.then(async () => {
      if (snapshot(await read()).revision !== revision) return null;
      await mkdir(dataDir, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify({ prompt }), { mode: 0o600 }); await rename(temporary, path); }
      finally { await unlink(temporary).catch(() => {}); }
      return snapshot(prompt);
    });
    pending = operation.catch(() => {});
    return operation;
  } };
}
