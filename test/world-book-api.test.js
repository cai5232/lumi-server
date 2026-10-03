import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const listen = async server => { await new Promise(r=>server.listen(0,'127.0.0.1',r)); return server.address().port; };
test('authorized API persists books, applies selection and injects updated content into model requests', async () => {
 const directory=await mkdtemp(join(tmpdir(),'lumi-world-api-')), seen=[];
 const provider=createServer(async(req,res)=>{
  let raw=''; for await(const c of req) raw+=c;
  res.writeHead(200,{'content-type':'application/json'});
  if(req.url.includes('/api/integrations/')) return res.end('{"related":""}');
  if(req.method==='GET') return res.end('[]');
  const payload=JSON.parse(raw); seen.push(payload);
  res.end(JSON.stringify({choices:[{message:{content:'好的'}}],usage:{prompt_tokens:100,completion_tokens:2}}));
 });
 const providerPort=await listen(provider), probe=createServer(); const port=await listen(probe); await new Promise(r=>probe.close(r));
 let child;
 const base=`http://127.0.0.1:${port}`;
 const start=async()=>{
  child=spawn(process.execPath,['src/index.js'],{env:{...process.env,PORT:String(port),LUMI_DATA_DIR:directory,LUMI_PUSH_API_TOKEN:'test',LUMI_MODEL_API_KEY:'test',LUMI_MODEL_API_URL:`http://127.0.0.1:${providerPort}/v1`,LUMI_MEMORY_API_URL:`http://127.0.0.1:${providerPort}`,LUMI_MODEL_NAME:'test-model',LUMI_CACHE_KEEPALIVE_ENABLED:'false'},stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return;}catch{} await new Promise(r=>setTimeout(r,50));} throw Error('backend unavailable');
 };
 const stop=async()=>{ if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r)); child.kill(); await done;} child=null; };
 const request=(path,method='GET',data,authorized=true)=>fetch(base+path,{method,headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer test'}:{})},...(data?{body:JSON.stringify(data)}:{})});
 const plain=()=>JSON.stringify(seen.at(-1).messages);
 try {
  await start();
  assert.equal((await request('/v1/world-books','GET',undefined,false)).status,401);
  const initial=await (await request('/v1/world-books')).json(); assert.equal(initial.revision,0);
  let settings=await (await request('/v1/world-books','PUT',{books:[{id:'b',name:'龙',entries:[{id:'e',content:'WORLD_DRAGON_V1',keywords:['dragon']}]}],activeBookIds:['b'],revision:0})).json();
  const chat=async content=>{ const r=await request('/v1/chats/default/messages','POST',{content}); assert.equal(r.status,200); assert.ok((await r.json()).assistantMessage); };
  await chat('dragon'); assert.ok(plain().includes('WORLD_DRAGON_V1'));
  settings.books[0].entries[0].content='WORLD_DRAGON_V2'; settings=await(await request('/v1/world-books','PUT',settings)).json();
  await chat('dragon again'); assert.ok(plain().includes('WORLD_DRAGON_V2')); assert.ok(!plain().includes('WORLD_DRAGON_V1'));
  assert.equal((await request('/v1/world-books','PUT',initial)).status,409);
  assert.equal((await request('/v1/chats/default/world-books','PUT',{bookIds:[]})).status,200);
  await chat('dragon once more'); assert.ok(!plain().includes('WORLD_DRAGON_V2'));
  assert.equal((await request('/v1/chats/default/world-books','PUT',{bookIds:null})).status,200);
  await stop(); await start();
  assert.equal((await(await request('/v1/world-books')).json()).revision,2);
  await chat('dragon after restart'); assert.ok(plain().includes('WORLD_DRAGON_V2'));
  settings.books=[]; settings.activeBookIds=[]; await request('/v1/world-books','PUT',settings);
  await chat('dragon after deletion'); assert.ok(!plain().includes('WORLD_DRAGON_V2'));
 } finally { await stop(); await new Promise(r=>provider.close(r)); await rm(directory,{recursive:true,force:true}); }
});
