import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes, createCipheriv } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const listen = async s => { await new Promise(r => s.listen(0, '127.0.0.1', r)); return s.address().port; };
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise,resolve}; };
async function fixture(sleeping) {
  const dir=await mkdtemp(join(tmpdir(),'lumi-wake-audit-'));
  const dreamEntered=deferred();let dreamResponse;
  const reply=(res,content)=>res.end(JSON.stringify({choices:[{message:{content}}],usage:{prompt_tokens:100,completion_tokens:10}}));
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    res.writeHead(200,{'content-type':'application/json'});
    if(req.method==='GET')return res.end('[]');
    if(req.url.includes('/api/integrations/'))return res.end('{"related":""}');
    const q=JSON.parse(raw),system=q.messages?.find(m=>m.role==='system')?.content||'';
    if(String(system).includes('REM 梦境导演')){dreamResponse=res;dreamEntered.resolve();return;}
    const main=q.messages?.some(m=>m.role==='user'&&String(m.content).includes('<emotion_state'));
    return reply(res,main?'audit manual reply':'{"events":[]}');
  });
  const modelPort=await listen(provider),probe=createServer(),port=await listen(probe);
  await new Promise(r=>probe.close(r));
  const time=Date.now();
  const thread={id:'default',title:'audit',lastChatProvider:'custom',lastChatModel:'test',cacheProvider:'custom',cacheModel:'test',
    proactive:{enabled:false,threadId:'default',actions:{message:true,phone:false,screen:false},intervalMin:30},
    messages:[{id:'original',role:'assistant',content:'audit original',createdAt:new Date(time-3600_000).toISOString()}],
    activity:{mode:sleeping?'sleeping':'sentinel',lastUserActivityAt:new Date(time-3600_000).toISOString(),nextWakeAt:null,
      sleepStartedAt:new Date(time-1800_000).toISOString(),sleepUntil:new Date(time+3600_000).toISOString(),nextDreamAt:sleeping?new Date(time-1).toISOString():null,dreamCycle:0},
    sleep:{episodic:[],semantic:[],dreams:[],reflections:[],pendingDreams:[],dreamArc:'',nightmare:null}};
  await writeFile(join(dir,'threads.json'),JSON.stringify({default:thread}));
  const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const bytes=Buffer.concat([cipher.update(JSON.stringify({key:'test',url:'https://model.test/v1',apiFormat:'openai',chatPath:'/chat/completions'})),cipher.final()]);
  await writeFile(join(dir,'murmur-routes.enc.json'),JSON.stringify({default:{provider:'custom',model:'test',customProvider:{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:bytes.toString('base64')}}}));
  const env={...process.env,PORT:String(port),LUMI_DATA_DIR:dir,LUMI_PUSH_API_TOKEN:'test',MURMUR_INTERNAL_TOKEN:'audit-internal',
    LUMI_MURMUR_KEY_ENCRYPTION_KEY:key.toString('hex'),LUMI_TEST_MODEL_TARGET:`http://127.0.0.1:${modelPort}`,LUMI_MEMORY_API_URL:`http://127.0.0.1:${modelPort}`,
    LUMI_PROMISE_ALARM_ENABLED:'false',LUMI_CACHE_KEEPALIVE_ENABLED:'false',LUMI_BACKGROUND_PULSE_MS:'100',LUMI_SLEEP_NIGHTMARE_PROBABILITY:'0',LUMI_SLEEP_DREAM_INTERVAL_MINUTES:'120'};
  for(const k of ['MURMUR_SERVICE_URL','GITHUB_MCP_URL','ENGAWA_MCP_URL','LETTERS_MAP_PASSWORD'])delete env[k];
  const child=spawn(process.execPath,['--import',new URL('./mock-model-fetch.js',import.meta.url).pathname,'src/index.js'],{cwd:new URL('..',import.meta.url),env,stdio:'ignore'});
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<150;i++){
    if(child.exitCode!==null)throw new Error('backend exited '+child.exitCode);
    try{if((await fetch(base+'/health')).ok)break;}catch{}
    await new Promise(r=>setTimeout(r,50));
  }
  return {dir,base,dreamEntered,release:()=>{if(dreamResponse)reply(dreamResponse,'SCENE 1: audit dream.\nDREAM_EMOTION: calm');},
    stop:async()=>{if(child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill();await end;}provider.closeAllConnections();await new Promise(r=>provider.close(r));await rm(dir,{recursive:true,force:true});}};
}

test('API REGRESSION: legitimate Bearer auth reaches parameter validation',async()=>{
  const f=await fixture(false);
  try{
    const request=auth=>fetch(f.base+'/v1/internal/murmur/generate',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify({threadId:'default',messages:[]})});
    const standard=await request('Bearer audit-internal');
    const raw=await request('audit-internal');
    assert.equal(standard.status,400,'valid standard Bearer header accepted');
    assert.equal(raw.status,400,'raw token passes auth and reaches empty-message validation');
    assert.equal((await raw.json()).error,'messages_required');
  }finally{await f.stop();}
});

test('API REGRESSION: manual chat interrupts a dream without losing messages or restoring sleep',async()=>{
  const f=await fixture(true);
  try{
    await Promise.race([f.dreamEntered.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('dream not started')),4000).unref())]);
    const response=await fetch(f.base+'/v1/chats/default/messages',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({content:'audit-live-user',provider:'custom',model:'test',customProvider:{apiKey:'test',baseURL:'https://model.test/v1',apiFormat:'openai'}})});
    assert.equal(response.status,200,await response.clone().text());
    const read=async()=>JSON.parse(await readFile(join(f.dir,'threads.json'),'utf8')).default;
    const before=await read();
    assert.ok(before.messages.some(m=>m.content==='audit-live-user'));
    assert.ok(before.messages.some(m=>m.content==='audit manual reply'));
    f.release();
    let after;
    for(let i=0;i<80;i++){
      after=await read();
      const health=await (await fetch(f.base+'/health')).json();
      if(!health.proactiveDiagnostic.backgroundPulseInFlight)break;
      await new Promise(r=>setTimeout(r,25));
    }
    assert.equal(after.sleep.dreams.length,0,'cancelled dream must not commit stale output');
    assert.equal(after.messages.some(m=>m.content==='audit-live-user'),true);
    assert.equal(after.messages.some(m=>m.content==='audit manual reply'),true);
    assert.equal(after.activity.mode,'sentinel');
  }finally{f.release();await f.stop();}
});
