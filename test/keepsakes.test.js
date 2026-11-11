import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeepsakeStore, keepsakeContext, runKeepsakeMarks, cleanKeepsake } from '../src/keepsakes.js';
const messages = [
  { id: '1', role: 'user', content: '外面下雨了' },
  { id: '2', role: 'assistant', content: '那就慢慢走，我陪你。' },
  { id: '3', role: 'user', content: '好，我们一起回家' },
  { id: '4', role: 'assistant', content: '我把灯留着。' }
];
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'keepsakes-'));
  let now = 100000;
  try { await fn(createKeepsakeStore(dir, () => now), dir, delta => now += delta); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test('snapshots survive chat edits, preserve context, deduplicate and stay thread scoped', () => fixture(async (store, dir) => {
  const input = { msg_ids: ['2', '3'], pre_you: '那天雨很大', send: true };
  const item = await store.create('a', input, messages);
  assert.deepEqual(item.lines, [['ta', messages[1].content], ['you', messages[2].content]]);
  assert.deepEqual(item.ctx, [['you', '外面下雨了']]);
  assert.deepEqual(item.ctxAfter, [['ta', '我把灯留着。']]);
  assert.equal((await store.create('a', input, messages)).key, item.key);
  assert.equal((await store.list('a')).length, 1);
  assert.deepEqual(await store.list('b'), []);
  await assert.rejects(store.meta('b', { key: item.key, title: 'other' }), /不存在/);
  await assert.rejects(store.create('a', { msg_ids: ['missing'] }, messages), /尚未同步/);
  const reopened = createKeepsakeStore(dir);
  assert.equal((await reopened.list('a'))[0].pre.you, '那天雨很大');
  const edited = messages.map(m => ({...m, content: 'edited'}));
  assert.notEqual((await reopened.list('a'))[0].lines[0][1], edited[1].content);
}));
test('concurrent comments persist, private notes stay private, AI replies clear pending facts and visits lift fog', () => fixture(async (store, dir, advance) => {
  const item = await store.create('a', { msg_ids: ['2'], send: false }, messages);
  assert.ok(!(await keepsakeContext(store, 'a')).includes(item.key));
  const privateNote = await store.comment('a', { key: item.key, text: 'private secret', send: false });
  assert.ok(!(await keepsakeContext(store, 'a')).includes('private secret'));
  advance(1000);
  const notes = await Promise.all(['one', 'two'].map(text => store.comment('a', { key: item.key, text, send: true })));
  assert.equal((await createKeepsakeStore(dir).list('a'))[0].notes.length, 3);
  assert.ok((await keepsakeContext(store, 'a')).includes('one'));
  await assert.rejects(store.comment('a', { key: item.key, text: 'bad', parent_id: 999 }), /不存在/);
  advance(1000);
  await store.comment('a', { key: item.key, text: '我记得', parent_id: notes[0].id }, 'ta');
  assert.ok(!(await keepsakeContext(store, 'a')).includes(item.key));
  await store.meta('a', { key: item.key, askMe: true });
  assert.ok((await keepsakeContext(store, 'a')).includes('"askMe":true'));
  await store.meta('a', { key: item.key, pre_me: '那天我在等你' }, 'ta');
  assert.ok(!(await keepsakeContext(store, 'a')).includes(item.key));
  advance(86400000);
  const visited = await store.meta('a', { key: item.key, visit: true });
  assert.equal(visited.touch, 86502000);
  await store.remove('a', item.key, privateNote.id);
  assert.equal((await store.list('a'))[0].notes[0].removed, true);
  await store.remove('a', item.key);
  assert.deepEqual(await store.list('a'), []);
}));
test('AI marks save actual matching ranges, supplement context, reply in thread and expose failures', () => fixture(async store => {
  const output = await runKeepsakeMarks('我想留着。⟪封存:一起回家|那就慢慢走|我们一起回家|雨夜的路上⟫', store, 'a', messages);
  assert.match(output, /已封存/);
  const [item] = await store.list('a');
  assert.equal(item.who, 'ta'); assert.equal(item.pre.ta, '雨夜的路上'); assert.equal(item.lines.length, 2);
  assert.match(await runKeepsakeMarks(`⟪泡:${item.key}|我还记得⟫`, store, 'a', messages), /留了一句/);
  await runKeepsakeMarks(`⟪前情:${item.key}|我在这里等你⟫`, store, 'a', messages);
  assert.equal((await store.list('a'))[0].pre.ta, '我在这里等你');
  assert.match(await runKeepsakeMarks(`⟪泡:${item.key}|别的会话⟫`, store, 'b', messages), /没保存/);
  assert.match(await runKeepsakeMarks('⟪封存:坏的|完全不存在|不存在⟫', store, 'a', messages), /找不到/);
  assert.match(await runKeepsakeMarks('⟪封存:不完整', store, 'a', messages), /不完整/);
  assert.equal(cleanKeepsake('正文<speech>朗读</speech>⟪泡:k:1|标签⟫'), '正文');
}));
