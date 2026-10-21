import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const listen = async server => {await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port;};
test('HTTP sticker requests send the saved name and caption to the model', {timeout:45000}, async () => {
 const directory=await mkdtemp(join(tmpdir(),'lumi-sticker-api-')), seen=[];
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  res.writeHead(200,{'content-type':'application/json'});
  if(req.url.includes('/api/integrations/'))return res.end('{"related":""}');
  if(req.method==='GET')return res.end('[]');
  seen.push(JSON.parse(raw));
  res.end(JSON.stringify({choices:[{message:{content:'测试回复'}}],usage:{prompt_tokens:100,completion_tokens:2}}));
 });
 const providerPort=await listen(provider), probe=createServer();
 const port=20000+Math.floor(Math.random()*10000);await new Promise(r=>probe.listen(port,'127.0.0.1',r));await new Promise(r=>probe.close(r));
 const target=`http://127.0.0.1:${providerPort}`, base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['--import',new URL('./mock-model-fetch.js',import.meta.url).pathname,'src/index.js'],{env:{...process.env,PORT:String(port),LUMI_DATA_DIR:directory,LUMI_PUSH_API_TOKEN:'test',LUMI_MODEL_API_KEY:'test',LUMI_TEST_MODEL_TARGET:target,LUMI_MODEL_API_URL:target+'/v1',LUMI_MEMORY_API_URL:target,LUMI_MODEL_NAME:'test-model',LUMI_CACHE_KEEPALIVE_ENABLED:'false',LUMI_PROMISE_ALARM_ENABLED:'false',DUETTO_INTERNAL_PORT:'0'},stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',chunk=>errors+=chunk);
 const request=(path,data)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test'},body:JSON.stringify(data)});
 try {
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready,'backend started: '+errors);
  const uploaded=await request('/v1/stickers',{name:'好日子我来了',category:'测试',dataURL:'data:image/png;base64,iVBORw0KGgo='});
  assert.equal(uploaded.status,201);
  const {sticker}=await uploaded.json();
  for(const extra of [{}, {stickerName:'好日子我来了'}]) {
   const response=await request('/v1/chats/default/messages',{content:'老公\n[表情: 好日子我来了]',contentType:'sticker',stickerImageURL:sticker.image,...extra,provider:'custom',model:'test-model',customProvider:{apiKey:'test',baseURL:'https://model.test/v1',apiFormat:'openai'}});
   assert.equal(response.status,200,await response.clone().text());
   const result=await response.json();assert.ok(result.assistantMessage);
   const message=seen.filter(p=>Array.isArray(p.messages)).at(-1)?.messages.filter(m=>m.role==='user').at(-1);
   const modelText=JSON.stringify(message);
   assert.ok(modelText.includes('好日子我来了'),modelText);
   assert.ok(modelText.includes('老公'),modelText);
   assert.ok(!modelText.includes('未命名'),modelText);
  }
 } finally {
  if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
  await new Promise(r=>provider.close(r));await rm(directory,{recursive:true,force:true});
 }
});
