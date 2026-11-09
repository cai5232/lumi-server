import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCipheriv} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmotionState} from '../src/emotion-native.js';
import {newIncomingCall} from '../src/incoming-call-lifecycle.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const listen=async server=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;};

async function fixture({expiresIn=800, openingDelay=0, providerFailure=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'lumi-call-timeout-'));const requests=[];
 const state=createEmotionState();
 const engine=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;res.setHeader('content-type','application/json');
 if(req.url.startsWith('/emotion/history'))return res.end('[]');
 if(req.url==='/emotion/state')return res.end(JSON.stringify({character:'aria',dimensions:state.dimensions,mood:'calm',saved_at:Date.now()/1000}));
 res.end(JSON.stringify({state:state.dimensions,applied:{},mood:'calm'}));});
 const enginePort=await listen(engine);
 const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;res.setHeader('content-type','application/json');
 if(req.method==='GET')return res.end('[]');
 if(req.url.includes('/api/integrations/'))return res.end('{"related":""}');
 const body=JSON.parse(raw||'{}');const main=body.messages?.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('<emotion_state'));
 if(main){requests.push(body);if(openingDelay)await pause(openingDelay);if(providerFailure){res.statusCode=502;return res.end('{"error":{"message":"test relay unavailable"}}');}}
 res.end(JSON.stringify({choices:[{message:{content:main?'知道了，等你有空再聊。':'{"events":[]}'}}],usage:{}}));});
 const providerPort=await listen(provider);const probe=createServer();await new Promise(resolve=>probe.listen(0,resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const iv=Buffer.alloc(12,1);const cipher=createCipheriv('aes-256-gcm',Buffer.alloc(32,2),iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify({url:'https://model.test/v1',key:'test-only',apiFormat:'openai'})),cipher.final()]);
 const modelRoute={provider:'custom',model:'test-model',updatedAt:Date.now(),customProvider:{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')}};
 const call=newIncomingCall('想听听你的声音');call.expiresAt=new Date(Date.now()+expiresIn).toISOString();
 await writeFile(join(dir,'threads.json'),JSON.stringify({default:{id:'default',title:'test',messages:[{id:'seed',role:'assistant',content:'给你打个电话。',createdAt:new Date().toISOString()}],calls:[call],lastChatProvider:'custom',modelRoute}}));
 const env={...process.env,DUETTO_INTERNAL_PORT:'0',LUMI_PROMISE_ALARM_ENABLED:'false',LUMI_MURMUR_KEY_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('hex'),LUMI_PUSH_API_TOKEN:'test-auth',LUMI_TEST_MODEL_TARGET:`http://127.0.0.1:${providerPort}`,PORT:String(port),LUMI_DATA_DIR:dir,MURMUR_SERVICE_URL:`http://127.0.0.1:${enginePort}`,LUMI_MODEL_API_URL:`http://127.0.0.1:${providerPort}/v1`,LUMI_MODEL_API_KEY:'test-only',LUMI_MODEL_NAME:'test-model',LUMI_MEMORY_API_URL:`http://127.0.0.1:${providerPort}`,LUMI_BACKGROUND_PULSE_MS:'60000',LUMI_CACHE_KEEPALIVE_ENABLED:'false'};
 const backend=spawn(process.execPath,['--import',new URL('./mock-model-fetch.js',import.meta.url).pathname,'src/index.js'],{cwd:new URL('..',import.meta.url),env,stdio:['ignore','ignore','pipe']});let logs='';backend.stderr.on('data',chunk=>{logs+=chunk;});
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<100;i++){if(backend.exitCode!==null){engine.closeAllConnections();provider.closeAllConnections();engine.close();provider.close();throw Error(logs)};try{if((await fetch(base+'/health')).ok)break;}catch{}await pause(50);}
 return {base,call,requests,dir,read:async()=>JSON.parse(await readFile(join(dir,'threads.json'),'utf8')).default,close:async()=>{backend.kill();await new Promise(resolve=>backend.exitCode!==null?resolve():backend.once('exit',resolve));await Promise.all([new Promise(resolve=>engine.close(resolve)),new Promise(resolve=>provider.close(resolve))]);await rm(dir,{recursive:true,force:true});}};
}

test('server expires a call without frontend polling, persists a hang-up bubble and makes exactly one normal chat request',async()=>{
 const f=await fixture();try{
  let thread;
  for(let i=0;i<150;i++){thread=await f.read();if(thread.calls[0].missedFollowUp?.state==='completed')break;await pause(50);}
  assert.equal(thread.calls[0].state,'ended');assert.equal(thread.calls[0].missedFollowUp?.state,'completed',await readFile(join(f.dir,'request-failures.json'),'utf8').catch(()=>''));
  assert.equal(thread.messages.filter(m=>m.callStatus==='missed').length,1);assert.equal(f.requests.length,1);
  const input=f.requests[0].messages.filter(m=>m.role==='user').at(-1).content;
  assert.match(JSON.stringify(input),/暂时无人接听/);assert.doesNotMatch(JSON.stringify(input),/internal_call_turn/);
  assert.ok(thread.messages.some(m=>m.missedCallID===f.call.id&&m.precedingUserModelContent.includes('暂时无人接听')));
  assert.equal(thread.messages.filter(m=>m.role==='user').length,0,'automatic trigger does not forge a visible user bubble');
  await Promise.all(Array.from({length:4},()=>fetch(f.base+'/v1/chats/default/calls/pending',{headers:{Authorization:'Bearer test-auth'}})));await pause(100);
  assert.equal(f.requests.length,1);assert.equal((await f.read()).messages.filter(m=>m.callStatus==='missed').length,1);
 }finally{await f.close();}
});
test('answer claims the call before a slow opening response, and timeout never marks it missed',async()=>{
 const f=await fixture({expiresIn:1500,openingDelay:1900});try{
  const response=await fetch(`${f.base}/v1/chats/default/calls/${f.call.id}/answer`,{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer test-auth'},body:JSON.stringify({action:'accept'})});
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const thread=await f.read();assert.equal(thread.calls[0].state,'active');assert.equal(thread.messages.filter(m=>m.callStatus==='missed').length,0);assert.equal(f.requests.length,1);
 }finally{await f.close();}
});
test('failed follow-up keeps the hang-up bubble and error observation without repeated automatic model requests',async()=>{
 const f=await fixture({providerFailure:true});try{
  let thread;for(let i=0;i<150;i++){thread=await f.read();if(thread.calls[0].missedFollowUp?.state==='failed')break;await pause(50);}
  assert.equal(thread.calls[0].missedFollowUp?.state,'failed');assert.equal(thread.messages.filter(m=>m.callStatus==='missed').length,1);
  const failures=JSON.parse(await readFile(join(f.dir,'request-failures.json'),'utf8')).events;assert.equal(failures[0].message,'暂时无人接听');
  await fetch(f.base+'/v1/chats/default/calls/pending',{headers:{Authorization:'Bearer test-auth'}});await pause(100);assert.equal(f.requests.length,1);
 }finally{await f.close();}
});
