import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('chat-wake-chat keeps byte-identical system/tools and Session, while enforcing wake permissions', {timeout:120000}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'lumi-harness-chat-'));
  const capture=join(dir,'sdk-calls.jsonl'), writes=join(dir,'memory-writes.jsonl');
  const capsuleFile=join(dir,'capsule-fixtures.json');
  await writeFile(capsuleFile,JSON.stringify({letters:[]}));
  await writeFile(join(dir,'lubdub-agent-token'),'a'.repeat(64));
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const duettoProbe=createServer();await new Promise(r=>duettoProbe.listen(0,'127.0.0.1',r));const duettoTestPort=duettoProbe.address().port;await new Promise(r=>duettoProbe.close(r));
  const fake=join(dir,'fake-sdk.mjs'),loader=join(dir,'loader.mjs'),preload=join(dir,'preload.mjs');
  await writeFile(fake,`import {appendFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
export const tool=(name,description,inputSchema,handler)=>({name,description,inputSchema,handler});
export const createSdkMcpServer=options=>options;
export function query({prompt,options}){return {close(){},async *[Symbol.asyncIterator](){
 const input=[];for await(const m of prompt)input.push(m);
 const session=options.resume||randomUUID();const blocks=input[0].message.content;const current=blocks.filter(b=>b.type==='text').at(-1)?.text||'';
 await appendFile(${JSON.stringify(capture)},JSON.stringify({resume:options.resume||null,session,system:typeof options.systemPrompt==='string'?options.systemPrompt:options.systemPrompt.prompt,input,tools:options.tools,definitions:options.mcpServers.lumi.tools.map(({name,description,inputSchema})=>({name,description,inputSchema})),registered:options.mcpServers.lumi.tools.map(t=>t.name)})+'\\n');
 yield {type:'system',subtype:'init',apiKeySource:'ANTHROPIC_API_KEY',session_id:session};
 if(current.includes('FAIL_HARNESS'))throw new Error('SYNTHETIC_KIMI_FAILURE');
 let text='测试回复';
 if(current.includes('<wake_delivery_protocol>')){
   const tools=options.mcpServers.lumi.tools;
   const calendar=tools.find(t=>t.name==='lumi_calendar_0_calendar_list');if(!calendar)throw Error('MISSING_STABLE_CALENDAR_SCHEMA');
   if(!(await calendar.handler({})).isError)throw Error('WAKE_CALENDAR_PERMISSION_LEAK');
   const mail=tools.find(t=>t.name==='lumi_email_mail_send');if(!mail)throw Error('MISSING_MAIL_SCHEMA');
   const forbidden=await mail.handler({to:'someone@example.com',subject:'test',body:'not sent'});
   if(!forbidden.isError||!JSON.stringify(forbidden).includes('自主唤醒发信仅允许'))throw Error('WAKE_MAIL_PERMISSION_LEAK');
   text='[[LUMI_SILENT_WAKE]]';
 }

 yield {type:'stream_event',event:{type:'message_start',message:{id:'m',usage:{input_tokens:100,cache_read_input_tokens:200}}}};
 yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}};
 yield {type:'assistant',message:{id:'m',content:[{type:'text',text}]}};
 yield {type:'result',subtype:'success',is_error:false,session_id:session,stop_reason:'end_turn',usage:{input_tokens:100,cache_read_input_tokens:200,output_tokens:10}};
}};}`);
  await writeFile(loader,`export async function resolve(specifier,context,next){if(specifier==='@anthropic-ai/claude-agent-sdk')return {url:${JSON.stringify(new URL('file://'+fake).href)},shortCircuit:true};return next(specifier,context);}`);
  await writeFile(preload,`import {register} from 'node:module';import {appendFile,readFile} from 'node:fs/promises';register(${JSON.stringify(new URL('file://'+loader).href)},import.meta.url);
const real=globalThis.fetch;globalThis.fetch=async(url,options={})=>{
 const u=String(url);if(u.startsWith('http://127.0.0.1:')&&!u.includes(':1/'))return real(url,options);
 if(u.includes('/lubdub/letters')){
   if(options.method && options.method!=='GET')throw Error('CAPSULE_AUTO_WRITE_FORBIDDEN');
   const state=JSON.parse(await readFile(${JSON.stringify(capsuleFile)},'utf8'));
   const id=new URL(u).pathname.match(/\\/letters\\/([a-f0-9]{8})$/)?.[1];
   return Response.json(id?state.letters.find(l=>l.id===id):state);
 }

 if(u.includes('/nook/memories')){await appendFile(${JSON.stringify(writes)},options.body+'\\n');return Response.json({ok:true});}
 if(u.includes('/nook/recall'))return Response.json({related:'已存在的合成记忆'});
 if(u.includes('model.test'))throw new Error('API_FALLBACK_FORBIDDEN');
 return Response.json({});};`);
  let child,stderr='';
  async function start(pulse=600000){
    stderr='';child=spawn(process.execPath,['--import',preload,'src/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),LUMI_DATA_DIR:dir,LUMI_PUSH_API_TOKEN:'test-token',LUMI_HARNESS_ENABLED:'true',LUMI_CHAT_RUNTIME:'kimi-harness',LUMI_KIMI_CODE_API_KEY:'fake-key',LUMI_KIMI_CODE_CONTEXT_TOKENS:'262144',LUMI_MEMORY_API_URL:'https://memory.test',LUMI_CACHE_KEEPALIVE_ENABLED:'false',LUMI_PROMISE_ALARM_ENABLED:'false',LUMI_BACKGROUND_PULSE_MS:String(pulse),LUMI_MAIL_MCP_URL:'https://mail.test/mcp',LUMI_MAIL_MCP_TOKEN:'fake-mail-token',LUMI_MAIL_ADDRESS:'test@example.com',LUMI_MAIL_PASSWORD:'fake-mail-password',DUETTO_INTERNAL_PORT:String(duettoTestPort)},stdio:['ignore','pipe','pipe']});
    child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>stderr+=b);
    for(let i=0;i<500;i++){if(child.exitCode!==null)throw Error(stderr);try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,40));}throw Error('backend not ready '+stderr);
  }
  async function stop(){if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();const force=setTimeout(()=>child.kill('SIGKILL'),3000);try{await ended;}finally{clearTimeout(force);}}}
  const base=`http://127.0.0.1:${port}`,headers={authorization:'Bearer test-token','content-type':'application/json'};
  const chat=(content,extra={})=>fetch(base+'/v1/chats/default/messages',{method:'POST',headers,body:JSON.stringify({content,...extra})});
  const calls=async()=>(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);
  try {
    await start();
    const tts={enabled:true,apiKey:'fake-tts-key',provider:'minimax',model:'speech-2.8-hd'};
    const initial=await chat('开始正常聊天',{tts});assert.equal(initial.status,200,await initial.clone().text());
    const afterCall=(await calls()).at(-1);
    assert.ok(afterCall.registered.includes('lumi_email_mail_send'),'fixture exercises configured mail');

    // Force one scheduled wake through the real scheduler without waiting 18m.
    await stop();
    const wakeSeed=JSON.parse(await readFile(join(dir,'threads.json'),'utf8'));
    const countBeforeWake=wakeSeed.default.messages.length;
    await writeFile(capsuleFile,JSON.stringify({letters:[{id:'aabb0011',status:'revealed',reveal_at:1700000000,title:'合成时间胶囊',content:'本地合成来信正文',replies:[]}]}));
    wakeSeed.default.activity={...wakeSeed.default.activity,mode:'sentinel',sleepPendingAt:null,nextWakeAt:new Date(Date.now()-1000).toISOString(),nextWakeSource:'settings'};
    await writeFile(join(dir,'threads.json'),JSON.stringify(wakeSeed));
    await writeFile(join(dir,'proactive-settings.json'),JSON.stringify({enabled:true,threadId:'default',intervalMin:18,intervalMax:18,dnd:false,actions:{message:true,phone:false,screen:false}}));
    const previousCount=(await calls()).length;
    await start(100);
    let wakeStored;
    for(let i=0;i<500;i++){
      wakeStored=JSON.parse(await readFile(join(dir,'threads.json'),'utf8')).default;
      if(wakeStored.activity.lastWakeAt && (await calls()).length>previousCount)break;
      await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(wakeStored.activity.lastWakeAt,stderr);
    assert.equal(wakeStored.messages.length,countBeforeWake,'silent wake adds no bubble');
    const wakeCall=(await calls()).at(-1);
    assert.equal(wakeCall.resume,afterCall.session);
    assert.ok(JSON.stringify(wakeCall.input).includes('本地合成来信正文'),'newly revealed letter reaches the next wake without a model tool lookup');
    assert.ok(JSON.stringify(wakeCall.input).includes('<time_capsule_inbox>'));
    assert.equal(wakeCall.system,afterCall.system,'chat and wake have identical system bytes');
    assert.deepEqual(wakeCall.definitions,afterCall.definitions,'full tool schemas and descriptions are identical');
    assert.ok(JSON.stringify(wakeCall.input).includes('<autonomous_mail_permission>'),'wake-only mail policy is a user suffix');
    assert.ok(JSON.stringify(afterCall.input).includes('<speech_enabled>true</speech_enabled>'));
    assert.ok(JSON.stringify(wakeCall.input).includes('<speech_enabled>false</speech_enabled>'));
    const returned=await chat('正常聊天回来',{tts});assert.equal(returned.status,200,await returned.clone().text());
    const returnedCall=(await calls()).at(-1);
    assert.equal(returnedCall.resume,afterCall.session);
    assert.ok(!JSON.stringify(returnedCall.input).includes('本地合成来信正文'),'accepted silent wake acknowledges the inbox without repeated injection');
    assert.ok(!(await readFile(join(dir,'lubdub-inbox.json'),'utf8')).includes('本地合成来信正文'),'receipts are not another letter/memory store');
    assert.equal(returnedCall.system,wakeCall.system);
    assert.deepEqual(returnedCall.definitions,wakeCall.definitions);
    const muted=await chat('继续聊',{tts:{...tts,enabled:false}});assert.equal(muted.status,200,await muted.clone().text());
    const mutedCall=(await calls()).at(-1);
    assert.equal(mutedCall.system,returnedCall.system,'TTS toggle cannot change the system prefix');
    assert.deepEqual(mutedCall.definitions,returnedCall.definitions);
    assert.equal(mutedCall.resume,afterCall.session);
    assert.ok(JSON.stringify(mutedCall.input).includes('<speech_enabled>false</speech_enabled>'));

  } finally {await stop();await rm(dir,{recursive:true,force:true});}
});
