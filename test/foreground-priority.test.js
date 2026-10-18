import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash,createCipheriv,randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('a user message interrupts a stalled sentinel and retains the conversation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-priority-'));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const settings={enabled:true,threadId:'default',intervalMin:10,actions:{message:true,phone:false,screen:false}};
 await writeFile(join(directory,'proactive-settings.json'),JSON.stringify(settings));
 await writeFile(join(directory,'threads.json'),JSON.stringify({default:{id:'default',title:'test',messages:[{id:'old',role:'user',content:'保留原文',createdAt:new Date(0).toISOString()}],lastChatProvider:'custom',lastChatModel:'test',proactive:settings,activity:{mode:'sentinel',lastUserActivityAt:new Date(0).toISOString(),nextWakeAt:new Date(0).toISOString(),nextWakeSource:'settings'}}}));
 const key=createHash('sha256').update('lumi-murmur-route-v1\\0').update('test-token').digest();
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.concat([cipher.update(JSON.stringify({key:'fake-key',url:'https://model.test/v1',apiFormat:'openai',chatPath:'/chat/completions'})),cipher.final()]);
 await writeFile(join(directory,'murmur-routes.enc.json'),JSON.stringify({default:{provider:'custom',model:'test',customProvider:{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}}}));
 const marker=join(directory,'wake-started');const cancelled=join(directory,'wake-cancelled');const preload=join(directory,'fetch.mjs');
 await writeFile(preload,`import {writeFile} from 'node:fs/promises';const real=globalThis.fetch;globalThis.fetch=async(url,options={})=>{
 if(String(url).startsWith('https://model.test/')){
  const body=JSON.parse(options.body);
  if(JSON.stringify(body.messages.at(-1)).includes('autonomous_wake_context')){
   await writeFile(${JSON.stringify(marker)},'yes');
   return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{void writeFile(${JSON.stringify(cancelled)},'yes');reject(new Error('aborted'));},{once:true}));
  }
  return new Response(JSON.stringify({choices:[{message:{content:'手动回复'}}]}));
 }
 if(!String(url).startsWith('http://127.0.0.1:')||String(url).startsWith('http://127.0.0.1:1/'))return new Response('{}');return real(url,options);
};`);
 const backend=spawn(process.execPath,['--import',preload,'src/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),LUMI_DATA_DIR:directory,LUMI_PUSH_API_TOKEN:'test-token',LUMI_MURMUR_KEY_ENCRYPTION_KEY:'',LUMI_MEMORY_API_URL:'http://127.0.0.1:1',LUMI_CACHE_KEEPALIVE_ENABLED:'false',LUMI_BACKGROUND_PULSE_MS:'100',LUMI_SYSTEM_PROMPT:'test'},stdio:'ignore'});
 try{
  let started=false;for(let i=0;i<100;i++){try{await readFile(marker);started=true;break;}catch{}if(backend.exitCode!==null)throw Error('backend exited');await new Promise(r=>setTimeout(r,50));}assert.ok(started,'sentinel must be in flight');
  const start=Date.now();
  const response=await fetch(`http://127.0.0.1:${port}/v1/chats/default/messages`,{method:'POST',signal:AbortSignal.timeout(3000),headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify({content:'我现在说话',provider:'custom',model:'test',customProvider:{apiKey:'fake-key',baseURL:'https://model.test/v1',apiFormat:'openai'}})});
  assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).assistantMessage.content,'手动回复');assert.ok(Date.now()-start<2000);
  assert.equal(await readFile(cancelled,'utf8'),'yes');
  const messages=JSON.parse(await readFile(join(directory,'threads.json'),'utf8')).default.messages;
  assert.equal(messages[0].content,'保留原文');assert.ok(messages.some(m=>m.content==='我现在说话'));assert.ok(messages.some(m=>m.content==='手动回复'));
 }finally{const done=new Promise(r=>backend.once('exit',r));backend.kill();if(backend.exitCode===null)await done;await rm(directory,{recursive:true,force:true});}
});
