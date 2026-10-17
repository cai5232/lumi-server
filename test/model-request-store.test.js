import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createModelRequestStore} from '../src/model-request-store.js';
test('request log indexing preserves legacy details and usage without rewriting all old prompts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-request-store-'));
 try{
  const legacy=JSON.stringify({requests:[{id:'old',createdAt:new Date().toISOString(),inputTokens:123,requestJSON:'历史原文',responseJSON:'原回复'}]});
  await writeFile(join(directory,'model-request-logs.json'),legacy);
  let store=createModelRequestStore(directory);
  await Promise.all(Array.from({length:25},(_,i)=>store.append({id:String(i),createdAt:new Date().toISOString(),inputTokens:i,requestJSON:'新请求 '+i,responseJSON:'新回复 '+i})));
  const result=await store.read();assert.equal(result.length,26);assert.equal(result[0].inputTokens,123);assert.equal(result.at(-1).requestJSON,'新请求 24');
  assert.equal(await readFile(join(directory,'model-request-logs.json'),'utf8'),legacy);
  const index=await readFile(join(directory,'model-request-index.json'),'utf8');assert.ok(!index.includes('新请求'),'index only holds usage metadata');
  store=createModelRequestStore(directory);const restored=await store.read();assert.equal(restored.at(-1).responseJSON,'新回复 24');assert.equal(restored[0].inputTokens,123);
 }finally{await rm(directory,{recursive:true,force:true})}
});
