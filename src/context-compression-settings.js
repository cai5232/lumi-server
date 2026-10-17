import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validCompressionRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 0.95;
}

export async function openCompressionSettings({ path, contextLimitTokens, defaultTriggerRatio }) {
  const minimumTriggerTokens = 1;
  const maximumTriggerTokens = Number.MAX_SAFE_INTEGER;
  const validTokens = value => Number.isSafeInteger(value) && value >= minimumTriggerTokens && value <= maximumTriggerTokens;
  let triggerTokens = Math.floor(contextLimitTokens * defaultTriggerRatio);
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (validTokens(saved.triggerTokens)) triggerTokens = saved.triggerTokens;
    else if (validCompressionRatio(saved.triggerRatio)) triggerTokens = Math.floor(contextLimitTokens * saved.triggerRatio);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Context compression settings could not be loaded; using the configured default.');
  }
  const snapshot = () => ({ triggerRatio: triggerTokens / contextLimitTokens, defaultTriggerRatio, contextLimitTokens, triggerTokensEstimate: triggerTokens, minimumTriggerTokens, maximumTriggerTokens });
  async function saveTokens(value) {
    if (!validTokens(value)) throw new Error('invalid_compression_tokens');
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ triggerTokens: value }), { mode: 0o600 });
    await rename(temporary, path);
    triggerTokens = value;
    return snapshot();
  }
  return {
    get snapshot() { return snapshot(); },
    validTokens,
    saveTokens,
    async save(value) {
      if (!validCompressionRatio(value)) throw new Error('invalid_compression_ratio');
      return saveTokens(Math.floor(contextLimitTokens * value));
    }
  };
}
