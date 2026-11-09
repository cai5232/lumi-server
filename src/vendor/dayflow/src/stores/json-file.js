import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function safeId(value) {
  const id = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (!id) throw new TypeError('conversation id is required');
  return id;
}

export class JsonFileStateStore {
  constructor(directory = '.dayflow') {
    this.directory = directory;
  }

  pathFor(id) {
    return join(this.directory, `${safeId(id)}.json`);
  }

  async load(id) {
    try { return JSON.parse(await readFile(this.pathFor(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async save(id, state) {
    const target = this.pathFor(id);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}
