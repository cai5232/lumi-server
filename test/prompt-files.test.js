import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { promptText, promptTemplate } from '../src/prompt-files.js';
import { CHAT_SYSTEM_PROMPT, DEFAULT_CHAT_PERSONA, CHAT_FEATURE_PROMPT } from '../src/chat-system-prompt.js';
import { contextSummaryMessages } from '../src/context-summary.js';
const manifest = JSON.parse(readFileSync(new URL('../prompts/manifest.json',import.meta.url),'utf8'));
const hash = text => createHash('sha256').update(text).digest('hex');
test('Markdown migration preserves every original byte and assembly order', () => {
  for (const [name,expected] of Object.entries(manifest.sha256)) assert.equal(hash(promptText(name)),expected,name);
  for (const [name,group] of Object.entries(manifest.groups)) assert.equal(hash(group.files.map(promptText).join('')),group.sha256,name);
  assert.equal(hash(CHAT_SYSTEM_PROMPT),manifest.groups.system.sha256);
  assert.equal(hash(DEFAULT_CHAT_PERSONA),manifest.groups.persona.sha256);
  assert.equal(hash(CHAT_FEATURE_PROMPT),manifest.groups.features.sha256);
  assert.equal(contextSummaryMessages('','')[0].content,CHAT_SYSTEM_PROMPT+promptText('compaction'));
  assert.match(promptText('compaction'), /【情感与关系】/);
  for (const [name,parts] of Object.entries(manifest.templates)) {
    const values = parts.slice(1).map((_,i) => `动态值${i}\n{{lumi:0}}`);
    const original = parts.map((part,i)=>part+(i<values.length?values[i]:'')).join('');
    assert.equal(promptTemplate(name,values),original,`${name}: original template interpolation`);
  }
});
