import { readFileSync } from 'node:fs';

const loaded = new Map();
// Do not trim or normalize: API cache prefixes and instruction order depend on
// exact bytes, including separators and leading/trailing newlines.
export function promptText(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid prompt module');
  if (!loaded.has(name)) loaded.set(name, readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8'));
  return loaded.get(name);
}

export function promptTemplate(name, values) {
  return promptText(name).replace(/\{\{lumi:(\d+)\}\}/g, (_match, index) => {
    if (!(index in values)) throw new Error(`Missing prompt slot ${name}:${index}`);
    return String(values[index]);
  });
}
