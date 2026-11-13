import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('a persisted partial boundary survives restart and retains the unprocessed suffix', () => {
  const start = source.indexOf('function contextMessages(');
  const end = source.indexOf('\nfunction messageTokens(', start);
  const bodyStart = source.indexOf('function compactionMessageBody(');
  const bodyEnd = source.indexOf('\nasync function compactContext(', bodyStart);
  const context = { historicalModelContent: value => value };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + source.slice(bodyStart, bodyEnd), context);
  const snapshot = JSON.parse(JSON.stringify({
    messages: [
      { id: 'old', content: 'already summarized' },
      { id: 'partial', content: 'included in summary. Still pending.' },
      { id: 'recent', content: 'recent reply' }
    ],
    compactedThroughMessageId: 'partial',
    compactedMessageOffset: 20
  }));
  assert.equal(context.contextMessages(snapshot)[0].content, ' Still pending.');
  assert.equal(context.contextMessages(snapshot)[1].id, 'recent');
  assert.equal(snapshot.messages[1].content, 'included in summary. Still pending.');
  delete snapshot.compactedMessageOffset;
  assert.equal(context.contextMessages(snapshot)[0].id, 'recent');
});
