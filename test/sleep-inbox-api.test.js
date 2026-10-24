import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port; }
async function fixture(probability, {holdDream = false} = {}) {
 const directory=await mkdtemp(join(tmpdir(),'lumi-sleep-inbox-')),seen=[];
 let failReplies=false,releaseDream;
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  if(!req.url.endsWith('/chat/completions')){res.writeHead(200,{'content-type':'application/json'});return res.end('{}')}
  const input=JSON.parse(raw);seen.push(input);
  const text=JSON.stringify(input);
  if(text.includes('REM 梦境导演')&&holdDream)await new Promise(resolve=>{releaseDream=resolve});
  if(text.includes('sleep_inbox')&&failReplies){res.writeHead(400,{'content-type':'application/json'});return res.end(JSON.stringify({error:{message:'fixture reply failure'}}))}
  const content=text.includes('REM 梦境导演')?'SCENE 1: 我走到海边。\nSCENE 2: 蓝色灯塔的门打开了。\nSCENE 3: 里面有一只小猫在等我。\nDREAM_EMOTION: 安心':text.includes('private Solo session')?'{"inner_activity":"一段安静的独处","duration_seconds":2}':'我看到了你睡眠期间说的每一件事。';
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content}}],usage:{prompt_tokens:100,completion_tokens:50}}));
 });
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const target=`http://127.0.0.1:${provider.address().port}`;
 let base='';
 let child;
 async function start(){
  base='';
  child=spawn(process.execPath,['--import',new URL('./mock-model-fetch.js',import.meta.url).pathname,'src/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',LUMI_DATA_DIR:directory,LUMI_PUSH_API_TOKEN:'test',LUMI_TEST_MODEL_TARGET:target,LUMI_MEMORY_API_URL:target,MURMUR_SERVICE_URL:'',LUMI_SLEEP_REPLY_PROBABILITY:String(probability),LUMI_SLEEP_DELAY_MINUTES:'.005',LUMI_SLEEP_HOURS:'.5',LUMI_SLEEP_DREAM_INTERVAL_MINUTES:'20',LUMI_SLEEP_NIGHTMARE_PROBABILITY:'0',LUMI_BACKGROUND_PULSE_MS:'100',LUMI_CACHE_KEEPALIVE_ENABLED:'false',LUMI_PROMISE_ALARM_ENABLED:'false',DUETTO_INTERNAL_PORT:'0'},stdio:['ignore','pipe','pipe']});
  let errors='',output='';child.stderr.on('data',c=>errors+=c);child.stdout.on('data',c=>{output+=c;const match=output.match(/Lumi server listening on :(\d+)/);if(match)base='http://127.0.0.1:'+match[1]});
  for(let i=0;i<400;i++){if(child.exitCode !== null)throw Error(errors);try{if(base&&(await fetch(base+'/health')).ok)return}catch{}await delay(50)}throw Error(errors);
 }
 async function stop(){if(child?.exitCode===null){const p=new Promise(r=>child.once('exit',r));child.kill();await p}}
 const request=(path,method='GET',data,key)=>fetch(base+path,{method,headers:{authorization:'Bearer test','content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(data?{body:JSON.stringify(data)}:{})});
 const chat=(content,key,extra={})=>request('/v1/chats/default/messages','POST',{content,provider:'custom',model:'test-model',customProvider:{apiKey:'test',baseURL:'https://model.test/v1',apiFormat:'openai'},...extra},key);
 async function waitFor(predicate){for(let i=0;i<180;i++){const value=await(await request('/v1/chats/default/sleep')).json();if(predicate(value))return value;await delay(50)}throw Error('sleep condition timed out')}
 try { await start(); } catch(error) { await stop(); await new Promise(r=>provider.close(r)); await rm(directory,{recursive:true,force:true}); throw error }
 return {directory,seen,request,chat,waitFor,start,stop,get base(){return base},setFail:value=>{failReplies=value},releaseDream:()=>{releaseDream?.();holdDream=false},cleanup:async()=>{releaseDream?.();await stop();await new Promise(r=>provider.close(r));await rm(directory,{recursive:true,force:true})}};
}
test('four silent messages survive restart; fifth wakes once with full dreams and all messages', {timeout:30000}, async()=>{
 const f=await fixture(0);
 try{
  assert.equal((await f.chat('晚安，先睡吧','bedtime-001')).status,200);
  const sleeping=await f.waitFor(x=>x.activity.mode==='sleeping'&&x.dreams.length>0);
  assert.match(sleeping.dreams[0].content,/小猫在等我/);
  for(let i=1;i<=4;i++){
   const reply=await f.chat('睡眠留言第'+i+'条','sleep-msg-00'+i);
   assert.equal(reply.status,200,await reply.clone().text());const body=await reply.json();assert.equal(body.replyDeferred,true);assert.equal(body.assistantMessage.content,'');
  }
  const before=f.seen.length;
  assert.equal((await(await f.chat('睡眠留言第1条','sleep-msg-001')).json()).replyDeferred,true);
  assert.equal((await f.chat('不同的消息','sleep-msg-001')).status,409);
  assert.equal(f.seen.length,before,'duplicate receipt never makes a paid call or a second wake roll');
  assert.equal((await f.waitFor(x=>x.pendingMessages===4)).activity.sleepMessageCount,4);
  await f.stop();await f.start();
  const reply=await f.chat('睡眠留言第5条','sleep-msg-005');assert.equal(reply.status,200,await reply.clone().text());
  const body=await reply.json();assert.ok(body.assistantMessage.content);
  const calls=f.seen.length;
  const replay=await(await f.chat('睡眠留言第5条','sleep-msg-005')).json();
  assert.equal(replay.assistantMessage.id,body.assistantMessage.id);assert.equal(f.seen.length,calls);
  const payload=JSON.stringify(f.seen.at(-1));
  for(let i=1;i<=5;i++)assert.ok(payload.includes('睡眠留言第'+i+'条'));
  assert.ok(payload.includes('小猫在等我'),'full dream ending reaches the reply model');
  const state=await f.waitFor(x=>x.pendingMessages===0);assert.equal(state.activity.mode,'sentinel');
  const disk=JSON.parse(await readFile(join(f.directory,'threads.json'),'utf8')).default;
  assert.equal(disk.messages.filter(m=>m.role==='user'&&m.content.startsWith('睡眠留言')).length,5);
  assert.equal(disk.messages.filter(m=>m.contentType==='sleep_deferred').length,0,'no fake assistant turn in transcript');
 }finally{await f.cleanup()}
});
test('natural wake answers queued messages even with proactive contact disabled; manual solo is authenticated and idempotent', {timeout:30000}, async()=>{
 const f=await fixture(0);
 try{
  await f.chat('晚安','bedtime-002');await f.waitFor(x=>x.activity.mode==='sleeping'&&x.dreams.length>0);
  await f.chat('记得明天的海边散步','sleep-natural-1');await f.stop();
  const path=join(f.directory,'threads.json'),threads=JSON.parse(await readFile(path,'utf8'));
  threads.default.activity.sleepUntil=new Date(Date.now()-1000).toISOString();await writeFile(path,JSON.stringify(threads));
  await f.start();await f.waitFor(x=>x.pendingMessages===0&&x.activity.mode==='sentinel');
  assert.ok(f.seen.some(x=>JSON.stringify(x).includes('记得明天的海边散步')&&JSON.stringify(x).includes('sleep_inbox')));
  const settings=await(await f.request('/v1/settings/solo')).json();
  assert.equal((await f.request('/v1/settings/solo','PUT',{...settings,cooldownMinutes:15,idleMinutes:10,desireThreshold:.6})).status,200);
  assert.equal((await(await f.request('/v1/settings/solo')).json()).cooldownMinutes,15);
  assert.equal((await fetch((await f.request('/v1/solo/metrics')).url.replace('/v1/solo/metrics','/v1/solo/trigger'),{method:'POST'})).status,401);
  let first;
  for(let i=0;i<40;i++){first=await f.request('/v1/solo/trigger','POST',{},'solo-manual-0001');if(first.status!==409)break;assert.equal((await first.clone().json()).error,'conversation_busy');await delay(25)}
  assert.equal(first.status,202,await first.clone().text());
  const second=await f.request('/v1/solo/trigger','POST',{},'solo-manual-0001');assert.equal(second.status,202);
  for(let i=0;i<100;i++){const rows=await(await f.request('/v1/solo/metrics')).json();if(rows.some(x=>x.trigger==='manual'))break;await delay(50)}
  assert.equal(f.seen.filter(x=>JSON.stringify(x).includes('private Solo session')).length,1);
 }finally{await f.cleanup()}
});
test('a successful random wake ends sleep and sees the waking user message', {timeout:45000}, async()=>{
 const f=await fixture(1);
 try{
  await f.chat('晚安','bedtime-003');await f.waitFor(x=>x.activity.mode==='sleeping'&&x.dreams.length>0);
  const reply=await f.chat('我突然想你了','sleep-random-001');assert.equal(reply.status,200,await reply.clone().text());
  assert.ok((await reply.json()).assistantMessage.content);
  const state=await f.waitFor(x=>x.activity.mode==='sentinel');assert.equal(state.pendingMessages,0);
 }finally{await f.cleanup()}
});

test('failed waking output retains every receipt until a later successful turn', {timeout:30000}, async()=>{
 const f=await fixture(0);
 try {
  await f.chat('晚安','bedtime-fail');await f.waitFor(x=>x.activity.mode==='sleeping'&&x.dreams.length>0);
  for(let i=1;i<=4;i++)await f.chat('未读消息'+i,'pending-fail-0'+i);
  f.setFail(true);
  assert.equal((await f.chat('未读消息5','pending-fail-05')).status,502);
  assert.equal((await f.waitFor(x=>x.activity.mode==='sentinel')).pendingMessages,5);
  f.setFail(false);
  const response=await f.chat('我刚才发的你都看到了吗','retry-after-fail');
  assert.equal(response.status,200,await response.clone().text());
  for(let i=1;i<=5;i++)assert.ok(JSON.stringify(f.seen.at(-1)).includes('未读消息'+i));
  await f.waitFor(x=>x.pendingMessages===0);
 } finally {await f.cleanup()}
});
test('a message interrupts a slow dream without losing the sleeping receipt', {timeout:30000}, async()=>{
 const f=await fixture(0,{holdDream:true});
 try {
  await f.chat('晚安','bedtime-race');await f.waitFor(x=>x.activity.mode==='sleeping');
  const started=Date.now();
  const response=await f.chat('做梦时我发的消息','during-slow-dream');
  assert.equal(response.status,200,await response.clone().text());assert.ok(Date.now()-started<2500);
  assert.equal((await response.json()).replyDeferred,true);
  f.releaseDream();
  const state=await f.waitFor(x=>x.pendingMessages===1);assert.equal(state.activity.mode,'sleeping');
  assert.equal((await fetch(f.base+'/v1/chats/default/sleep')).status,401);
 } finally {await f.cleanup()}
});
