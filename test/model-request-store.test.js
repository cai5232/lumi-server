import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createModelRequestStore,modelRequestLogJSON} from '../src/model-request-store.js';
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

test('summary reads skip huge detail files; old details are sanitized on demand without rewriting history',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-request-details-'));
 try{
  const id='large-image',image='A'.repeat(3_000_000);
  const record={id,createdAt:new Date().toISOString(),status:200,inputTokens:161092,outputTokens:0,detailStored:true};
  const path=join(directory,'model-request-details',createHash('sha256').update(id).digest('hex')+'.json');
  await mkdir(join(directory,'model-request-details'));
  await writeFile(join(directory,'model-request-index.json'),JSON.stringify({requests:[record]}));
  await writeFile(path,'invalid details must not be opened for summary');
  const store=createModelRequestStore(directory);
  assert.deepEqual(await store.read({includeDetails:false}),[record]);
  const request={messages:[{role:'user',content:[{type:'text',text:'保留这句原文'},{type:'image',source:{type:'base64',media_type:'image/jpeg',data:image}}]}]};
  const raw=JSON.stringify({...record,requestJSON:JSON.stringify(request),responseJSON:JSON.stringify({content:[{type:'text',text:''}],stop_reason:'end_turn'})});
  await writeFile(path,raw);
  const detail=await store.detail(id);
  assert.ok(detail.requestJSON.includes('保留这句原文'));
  assert.ok(detail.requestJSON.length<500);
  assert.equal(JSON.parse(detail.requestJSON).messages[0].content[1].source.data,'[image attachment omitted]');
  assert.equal(await readFile(path,'utf8'),raw);
  assert.equal(await store.detail('../unknown'),null);
  assert.equal(request.messages[0].content[1].source.data,image,'logging never mutates live request');
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('new and legacy log details omit both native Base64 and inline image URLs',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-request-images-'));
 try{
  const request={messages:[{content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'AAAA'}},{type:'image_url',image_url:{url:'data:image/png;base64,BBBB'}}]}]};
  const serialized=modelRequestLogJSON(request);
  assert.ok(!serialized.includes('AAAA'));assert.ok(!serialized.includes('BBBB'));
  assert.equal(request.messages[0].content[0].source.data,'AAAA');
  const legacy={id:'legacy',createdAt:new Date().toISOString(),requestJSON:JSON.stringify(request),responseJSON:'保留原文\n第二行'};
  await writeFile(join(directory,'model-request-logs.json'),JSON.stringify({requests:[legacy]}));
  let store=createModelRequestStore(directory);
  assert.ok(!(await store.detail('legacy')).requestJSON.includes('AAAA'));
  assert.equal((await store.detail('legacy')).responseJSON,legacy.responseJSON);
  await store.append({...legacy,id:'new'});
  store=createModelRequestStore(directory);
  assert.ok(!(await store.detail('new')).requestJSON.includes('AAAA'));
  assert.ok(!(await store.detail('new')).requestJSON.includes('BBBB'));
 }finally{await rm(directory,{recursive:true,force:true})}
});
