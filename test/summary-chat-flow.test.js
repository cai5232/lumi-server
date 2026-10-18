import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('real chat sends the summary once, reuses its prefix, keeps stored history, and returns upstream 503', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-summary-chat-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const summary = '唯一滚动摘要'.repeat(1000);
  const legacy = `<system_context timezone="Asia/Shanghai"><context_summary source="system">${summary}</context_summary></system_context>历史用户原文`;
  await writeFile(join(directory,'threads.json'),JSON.stringify({default:{id:'default',title:'test',contextSummary:summary,messages:[
    {id:'old-user',role:'user',content:'历史用户原文',modelContent:legacy},
    {id:'old-assistant',role:'assistant',content:'历史回复',precedingUserModelContent:legacy+'<internal_proactive_nudge>主动问候</internal_proactive_nudge>'}
  ]}}));
  const capture = join(directory, 'captured.jsonl');
  const preload = join(directory,'mock-fetch.mjs');
  await writeFile(preload, `import {appendFile} from 'node:fs/promises';
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
 if(String(url).startsWith('https://model.test/')){
  const body=JSON.parse(options.body);await appendFile(${JSON.stringify(capture)},JSON.stringify(body)+'\\n');
  if(body.model==='slow-disabled-model')await new Promise(resolve=>setTimeout(resolve,180));
  if(body.model==='disabled-model'||body.model==='slow-disabled-model')return new Response(JSON.stringify({error:{message:'auth_unavailable: no auth available'}}),{status:503});
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:'测试回复'}}]})+'\\n\\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:200,completion_tokens:3}})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
 }
 if(String(url).startsWith('http://127.0.0.1:1/')||!String(url).startsWith('http://127.0.0.1:'))return new Response('{}');
 return realFetch(url,options);
};`);
  const backend = spawn(process.execPath,['--import',preload,'src/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),LUMI_DATA_DIR:directory,LUMI_PUSH_API_TOKEN:'test-token',LUMI_MEMORY_API_URL:'http://127.0.0.1:1',LUMI_CACHE_KEEPALIVE_ENABLED:'false',LUMI_BACKGROUND_PULSE_MS:'600000'},stdio:'ignore'});
  try {
    const base=`http://127.0.0.1:${port}`;
    let ready=false;
    for(let i=0;i<100;i++){
      if(backend.exitCode!==null)throw Error('backend exited');
      try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(ready);
    const chat=(content,model='test-model',key='')=>fetch(base+'/v1/chats/default/messages',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token',...(key?{'idempotency-key':key}:{})},body:JSON.stringify({content,provider:'custom',model,customProvider:{apiKey:'fake-key',baseURL:'https://model.test/v1',apiFormat:'openai'}})});
    for(const content of ['第一轮新消息','第二轮新消息']){
      const response=await chat(content);assert.equal(response.status,200,await response.clone().text());
      assert.equal((await response.json()).assistantMessage.content,'测试回复');
      if(content==='第一轮新消息'){
        // Simulate a legacy cache snapshot whose earlier hidden predecessor
        // still embeds the summary. The last user block and cache key match.
        const path=join(directory,'threads.json');
        const threads=JSON.parse(await readFile(path,'utf8'));
        const cached=threads.default.cacheKeepaliveMessages;
        const user=cached.find(m=>m.role==='user'&&m.content.startsWith('<system_context'));
        user.content=user.content.replace('</system_context>',`<context_summary source="system">${summary}</context_summary></system_context>`);
        await writeFile(path,JSON.stringify(threads));
      }
    }
    const requests=(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.messages?.some(m=>String(m.content).includes('第一轮新消息')));
    const first=requests.find(x=>x.messages.at(-1).content.includes('第一轮新消息'));
    const second=requests.find(x=>x.messages.at(-1).content.includes('第二轮新消息'));
    for(const request of [first,second]){
      assert.ok(request);
      assert.equal(request.stream,true);
      assert.equal(JSON.stringify(request).split(summary).length-1,1);
      assert.ok(request.messages[0].content.includes(summary));
      assert.ok(request.messages.some(m=>m.content.includes('历史用户原文')));
    }
    assert.deepEqual(second.messages.slice(0,first.messages.length),first.messages);
    const stored=JSON.parse(await readFile(join(directory,'threads.json'),'utf8')).default;
    assert.equal(stored.messages[0].modelContent,legacy);
    const failed=await chat('故障模型测试','disabled-model');
    assert.equal(failed.status,503);
    assert.match((await failed.json()).error,/上游渠道不可用/);
    const routes=JSON.parse(await readFile(join(directory,'murmur-routes.enc.json'),'utf8'));
    assert.equal(routes.default.model,'disabled-model','failed turns must save the newly selected route');
    assert.ok(routes.default.customProvider.data);
    assert.ok(!JSON.stringify(routes).includes('fake-key'),'saved credentials stay encrypted');
    const retry=()=>chat('相同消息的网络重试','slow-disabled-model','retry-failed-123');
    const failures=await Promise.all([retry(),retry()]);
    for(const response of failures){assert.equal(response.status,503);assert.match((await response.json()).error,/上游渠道不可用/);}
    assert.equal((await retry()).status,503,'a later retry must retain the original failure');
    assert.equal((await chat('不同消息','slow-disabled-model','retry-failed-123')).status,409);
    const failedCalls=(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.model==='slow-disabled-model');
    assert.equal(failedCalls.length,1,'concurrent and later retries must not start another paid model call');
  }finally{
    const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill();if(backend.exitCode===null)await stopped;
    await rm(directory,{recursive:true,force:true});
  }
});
