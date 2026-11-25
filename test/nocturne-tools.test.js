import test from 'node:test';
import assert from 'node:assert/strict';
import { createNocturneTools } from '../src/nocturne-tools.js';
test('recall/read never write, unavailable detail tools are omitted, explicit writes are deduplicated only within a turn',async()=>{
  let writes=0,updates=0;const trace=[];
  const options={allowWrites:true,trace,search:async()=>({memories:['已有记忆']}),write:async()=>{writes++;return true;}};
  const basic=createNocturneTools(options);
  assert.deepEqual(basic.tools.map(t=>t.name),['memory_search','memory_write']);
  await basic.execute('memory_search',{query:'记忆'});assert.equal(writes,0);
  await basic.execute('memory_write',{content:'新事实'});await basic.execute('memory_write',{content:'新事实'});assert.equal(writes,1);
  const full=createNocturneTools({...options,get:async id=>({id,content:'原文'}),update:async id=>{updates++;return {id,ok:true};}});
  await full.execute('memory_get',{id:'one'});assert.equal(writes,1);assert.equal(updates,0);
  await full.execute('memory_update',{id:'one',content:'更新'});assert.equal(updates,1);assert.equal(writes,1);
  await createNocturneTools({...options,trace:[]}).execute('memory_write',{content:'新事实'});assert.equal(writes,2,'another explicitly requested turn is not globally suppressed');
});


test('production defaults are read-only and reject even direct calls to hidden write/update handlers', async()=>{
 let writes=0,updates=0;
 const readonly=createNocturneTools({trace:[],search:async()=>({matches:['已有记忆']}),get:async()=>({content:'已有记忆'}),write:async()=>{writes++;return true;},update:async()=>{updates++;return {ok:true};}});
 assert.deepEqual(readonly.tools.map(t=>t.name),['memory_search','memory_get']);
 await readonly.execute('memory_search',{query:'共同经历'});
 await readonly.execute('memory_get',{id:'one'});
 assert.equal((await readonly.execute('memory_write',{content:'不应通过MCP保存'})).isError,true);
 assert.equal((await readonly.execute('memory_update',{id:'one',content:'不应通过MCP修改'})).isError,true);
 assert.equal(writes,0);assert.equal(updates,0);
});
