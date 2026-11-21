import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const historyFingerprint = messages => fingerprint(messages.map(m => ({
  role: m.role, content: m.content || '', images: m.imageAttachmentCount || m.modelImageIDs?.length || 0,
  tools: m.toolCalls || [],
})));

async function processStart(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}

// Shared-volume locks are never stolen on a timer while an SDK/tool is running.
// Dead local owners are recoverable after a process/container restart. This
// backend's JSON archive still requires ONE application replica (see docs).
export function createHarnessState(root) {
  const pathFor = key => join(root, `${fingerprint(key)}.json`);
  return {
    async read(key) {
      try { return JSON.parse(await readFile(pathFor(key), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
    },
    async write(key, value) {
      await mkdir(root, { recursive: true });
      const path = pathFor(key), temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, path);
    },
    async lock(key) {
      await mkdir(root, { recursive: true });
      const path = `${pathFor(key)}.lock`;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await mkdir(path);
          await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, processStart: await processStart(process.pid) }), { mode: 0o600 });
          return () => rm(path, { recursive: true, force: true });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let owner;
          try { owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')); }
          catch {
            // A crash between mkdir and owner write must not leave an eternal
            // lock. A live owner is never expired by this orphan-only rule.
            if (Date.now() - (await stat(path)).mtimeMs > 120000) { await rm(path, { recursive: true, force: true }); continue; }
            throw Object.assign(new Error('Harness Session 正在初始化，请稍后重试'), { statusCode: 409 });
          }
          let alive = true;
          try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
          const currentStart = alive && owner.processStart ? await processStart(owner.pid) : null;
          if (currentStart && currentStart !== owner.processStart) alive = false;
          if (alive) throw Object.assign(new Error('此聊天的 Harness Session 正忙'), { statusCode: 409 });
          await rm(path, { recursive: true, force: true });
        }
      }
      throw new Error('Harness session lock unavailable');
    },
  };
}
