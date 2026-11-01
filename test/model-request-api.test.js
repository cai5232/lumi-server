import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createModelRequestStore} from '../src/model-request-store.js';
const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
const start=source.indexOf('    const modelRequestDetailMatch =');
const end=source.indexOf('    if (url.pathname === "/promise-alarm"',start);
test('usage list is small, detail is loaded separately, and both endpoints require authorization',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-request-api-'));
 try{
  const store=createModelRequestStore(directory);
  await store.append({id:'one',createdAt:new Date().toISOString(),provider:'custom',model:'chosen',status:200,durationMs:10,inputTokens:10,outputTokens:1,cachedTokens:0,requestJSON:JSON.stringify({prompt:'上下文'.repeat(100000)}),responseJSON:'{"text":"你好"}'});
  const context={URL,Date,Map,Math,Number,Array,decodeURIComponent,modelRequestStore:store,res:{},pushRequestAuthorized:req=>req.authorized,send:(_,status,value)=>({status,value})};
  vm.createContext(context);vm.runInContext(`async function endpoint(req) { ${source.slice(start,end)} }`,context);
  for(const path of ['/v1/usage/requests','/v1/usage/requests?summary=1']){
   context.url=new URL('http://test'+path);
   assert.equal((await context.endpoint({method:'GET'})).status,401);
   const summary=await context.endpoint({method:'GET',authorized:true});
   assert.equal(summary.status,200);assert.equal(summary.value.week.requests,1);
   assert.ok(JSON.stringify(summary.value).length<2000);
   assert.equal(summary.value.requests[0].requestJSON,undefined);
  }
  context.url=new URL('http://test/v1/usage/requests/one');
  assert.equal((await context.endpoint({method:'GET'})).status,401);
  const detail=await context.endpoint({method:'GET',authorized:true});
  assert.equal(detail.status,200);assert.ok(detail.value.requestJSON.includes('上下文'));
  context.url=new URL('http://test/v1/usage/requests/missing');
  assert.equal((await context.endpoint({method:'GET',authorized:true})).status,404);
 }finally{await rm(directory,{recursive:true,force:true})}
});
