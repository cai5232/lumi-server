import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validCompressionRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 0.95;
}

export async function openCompressionSettings({ path, contextLimitTokens, defaultTriggerRatio }) {
  let triggerRatio = defaultTriggerRatio;
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (validCompressionRatio(saved.triggerRatio)) triggerRatio = saved.triggerRatio;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Context compression settings could not be loaded; using the configured default.');
  }
  const snapshot = () => ({ triggerRatio, defaultTriggerRatio, contextLimitTokens, triggerTokensEstimate: Math.floor(contextLimitTokens * triggerRatio) });
  return {
    get snapshot() { return snapshot(); },
    async save(value) {
      if (!validCompressionRatio(value)) throw new Error('invalid_compression_ratio');
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ triggerRatio: value }), { mode: 0o600 });
      await rename(temporary, path);
      triggerRatio = value;
      return snapshot();
    }
  };
}
