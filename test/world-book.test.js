import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeBooks, evaluateBooks, injectBooks, WorldBookStore } from '../src/world-book.js';
const books = entries => normalizeBooks([{ id: 'book', entries }]);
const user = content => ({ role: 'user', content });
test('keyword/regex matching, disabled entries, priorities and all injection positions', () => {
  const entries = [
    {id:'a', content:'AFTER', constantActive:true},
    {id:'b', content:'BEFORE', keywords:['DRAGON'], position:'BEFORE_SYSTEM_PROMPT'},
    {id:'t', content:'TOP', constantActive:true, position:'TOP_OF_CHAT', role:'ASSISTANT'},
    {id:'z', content:'BOTTOM', keywords:['[', 'drag.*'], useRegex:true, position:'BOTTOM_OF_CHAT'},
    {id:'d', content:'DEPTH', constantActive:true, position:'AT_DEPTH', injectDepth:2, priority:10},
    {id:'off', content:'OFF', constantActive:true, enabled:false},
    {id:'case', content:'CASE', keywords:['DRAGON'], caseSensitive:true}
  ];
  const result = evaluateBooks(books(entries), [user('dragon')], [user('dragon')]);
  assert.deepEqual(result.entries.map(e=>e.id), ['d','a','b','t','z']);
  const messages = injectBooks([{role:'system',content:'BASE'},user('hello'),{role:'assistant',content:'hi'},user('dragon')],result.entries);
  assert.equal(messages[0].content,'BEFORE\nBASE\nAFTER');
  assert.deepEqual(messages[1],{role:'assistant',content:'TOP'});
  assert.equal(messages.at(-1).content,'dragon');
  assert.ok(messages.some(m=>m.content==='<system>\nDEPTH\n</system>'));
  assert.ok(messages.some(m=>m.content==='<system>\nBOTTOM\n</system>'));
});
test('timed effects persist, same history is idempotent, rewinding and edits invalidate effects', () => {
  const b = books([{id:'timed',content:'TIMED',keywords:['dragon'],scanDepth:1,sticky:2,cooldown:2,delay:3}]);
  const history = [user('a'),{role:'assistant',content:''},user('dragon')];
  assert.equal(evaluateBooks(b,history.slice(0,1),history.slice(0,1)).entries.length,0);
  const first = evaluateBooks(b,history,history);
  assert.equal(first.entries.length,1);
  assert.deepEqual(evaluateBooks(b,history,history,first.state),first);
  history.push({role:'assistant',content:'away'},user('away'));
  const sticky = evaluateBooks(b,history,history,first.state); assert.equal(sticky.entries.length,1);
  history.push({role:'assistant',content:'away'},user('dragon'));
  const cooling = evaluateBooks(b,history,history,sticky.state); assert.equal(cooling.entries.length,0);
  history.push({role:'assistant',content:'away'},user('dragon'));
  assert.equal(evaluateBooks(b,history,history,cooling.state).entries.length,1);
  assert.equal(evaluateBooks(b,[user('away')],[user('away')],first.state).entries.length,0);
  b[0].entries[0].content='EDITED';
  assert.equal(evaluateBooks(b,[user('away')],history,first.state).entries.length,0);
});
test('injections cannot split assistant tool calls from results', () => {
  const e=books([{content:'DEPTH',constantActive:true,position:'AT_DEPTH',injectDepth:2}])[0].entries;
  const messages=injectBooks([user('hello'),{role:'assistant',content:'',tool_calls:[{id:'one'}]},{role:'tool',content:'answer'},user('end')],e);
  assert.equal(messages.findIndex(m=>m.role==='tool'),messages.findIndex(m=>m.tool_calls)+1);
});
test('atomic persistence rejects conflicting saves and reloads active selections', async () => {
  const directory=await mkdtemp(join(tmpdir(),'lumi-world-books-'));
  try {
    const path=join(directory,'books.json'), store=new WorldBookStore(path);
    const next={books:books([{content:'A'}]),activeBookIds:['book','unknown'],revision:0};
    const result=await Promise.allSettled([store.save(next),store.save(next)]);
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(result.find(r=>r.status==='rejected').reason.status,409);
    assert.deepEqual((await new WorldBookStore(path).read()).activeBookIds,['book']);
    await store.save({...await store.read(),books:[]});
    assert.deepEqual((await store.read()).activeBookIds,[]);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
