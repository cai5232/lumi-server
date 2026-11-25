import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('existing chat HTTP route: Harness stream/image/memory, restart/resume, failure archive, explicit API selection and summary rebuild', {timeout:120000}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'lumi-harness-chat-'));
  const capture=join(dir,'sdk-calls.jsonl'), writes=join(dir,'memory-writes.jsonl');
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const duettoProbe=createServer();await new Promise(r=>duettoProbe.listen(0,'127.0.0.1',r));const duettoTestPort=duettoProbe.address().port;await new Promise(r=>duettoProbe.close(r));
  const fake=join(dir,'fake-sdk.mjs'),loader=join(dir,'loader.mjs'),preload=join(dir,'preload.mjs');
  await writeFile(fake,`import {appendFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
export const tool=(name,description,inputSchema,handler)=>({name,description,inputSchema,handler});
export const createSdkMcpServer=options=>options;
export function query({prompt,options}){return {close(){},async *[Symbol.asyncIterator](){
 const input=[];for await(const m of prompt)input.push(m);
 const session=options.resume||randomUUID();const blocks=input[0].message.content;const current=blocks.filter(b=>b.type==='text').at(-1)?.text||'';
 await appendFile(${JSON.stringify(capture)},JSON.stringify({resume:options.resume||null,session,system:typeof options.systemPrompt==='string'?options.systemPrompt:options.systemPrompt.prompt,input,tools:options.tools,registered:options.mcpServers.lumi.tools.map(t=>t.name)})+'\\n');
 yield {type:'system',subtype:'init',apiKeySource:'ANTHROPIC_API_KEY',session_id:session};
 if(current.includes('FAIL_HARNESS'))throw new Error('SYNTHETIC_KIMI_FAILURE');
 let text='测试回复';
 if(current.includes('MEMORY_TEST')){const tools=options.mcpServers.lumi.tools;await tools.find(t=>t.name==='memory_search').handler({query:'共同回忆'});await tools.find(t=>t.name==='memory_write').handler({content:'合成记忆'});await tools.find(t=>t.name==='memory_write').handler({content:'合成记忆'});text+='<memory>合成记忆</memory>';}
 if(current.includes('STUDIO_TEST')){const tools=options.mcpServers.lumi.tools;const read=await tools.find(t=>t.name==='lumi_chibi_read').handler({path:'templates/小狐狸1.chibi.json'});const document=JSON.parse(JSON.parse(read.content[0].text).content);await tools.find(t=>t.name==='lumi_chibi_render').handler({document,caption:'本地模拟画作'});}
 if((typeof options.systemPrompt==='string'?options.systemPrompt:options.systemPrompt.prompt).includes('当前任务：由你整理'))text='<context_summary>【情感与关系】我与言言记得合成约定，原话“下次一起看星星”。未完成：继续聊天。</context_summary>';
 yield {type:'stream_event',event:{type:'message_start',message:{id:'m',usage:{input_tokens:100,cache_read_input_tokens:200}}}};
 yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}};
 yield {type:'assistant',message:{id:'m',content:[{type:'text',text}]}};
 yield {type:'result',subtype:'success',is_error:false,session_id:session,stop_reason:'end_turn',usage:{input_tokens:100,cache_read_input_tokens:200,output_tokens:10}};
}};}`);
  await writeFile(loader,`export async function resolve(specifier,context,next){if(specifier==='@anthropic-ai/claude-agent-sdk')return {url:${JSON.stringify(new URL('file://'+fake).href)},shortCircuit:true};return next(specifier,context);}`);
  await writeFile(preload,`import {register} from 'node:module';import {appendFile} from 'node:fs/promises';register(${JSON.stringify(new URL('file://'+loader).href)},import.meta.url);
const real=globalThis.fetch;globalThis.fetch=async(url,options={})=>{
 const u=String(url);if(u.startsWith('http://127.0.0.1:')&&!u.includes(':1/'))return real(url,options);
 if(u.includes('/nook/memories')){await appendFile(${JSON.stringify(writes)},options.body+'\\n');return Response.json({ok:true});}
 if(u.includes('/nook/recall'))return Response.json({related:'已存在的合成记忆'});
 if(u.includes('model.test'))throw new Error('API_FALLBACK_FORBIDDEN');
 return Response.json({});};`);
  let child,stderr='';
  async function start(){
    stderr='';child=spawn(process.execPath,['--import',preload,'src/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),LUMI_DATA_DIR:dir,LUMI_PUSH_API_TOKEN:'test-token',LUMI_HARNESS_ENABLED:'true',LUMI_CHAT_RUNTIME:'kimi-harness',LUMI_KIMI_CODE_API_KEY:'fake-key',LUMI_KIMI_CODE_CONTEXT_TOKENS:'100000',LUMI_MEMORY_API_URL:'https://memory.test',LUMI_CACHE_KEEPALIVE_ENABLED:'false',LUMI_PROMISE_ALARM_ENABLED:'false',LUMI_BACKGROUND_PULSE_MS:'600000',DUETTO_INTERNAL_PORT:String(duettoTestPort)},stdio:['ignore','pipe','pipe']});
    child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>stderr+=b);
    for(let i=0;i<500;i++){if(child.exitCode!==null)throw Error(stderr);try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,40));}throw Error('backend not ready '+stderr);
  }
  async function stop(){if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();const force=setTimeout(()=>child.kill('SIGKILL'),3000);try{await ended;}finally{clearTimeout(force);}}}
  const base=`http://127.0.0.1:${port}`,headers={authorization:'Bearer test-token','content-type':'application/json'};
  const chat=(content,extra={})=>fetch(base+'/v1/chats/default/messages',{method:'POST',headers,body:JSON.stringify({content,...extra})});
  const calls=async()=>(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);
  try {
    console.log('harness-test-phase: initial');
    await start();
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhT8AAAAASUVORK5CYII=';
    const first=await chat('MEMORY_TEST STUDIO_TEST',{images:[image],stream:true});
    assert.equal(first.status,200,await first.clone().text());
    const stream=await first.text();assert.match(stream, /"type":"text"/);assert.match(stream,/"type":"complete"/);assert.ok(!stream.includes('<memory>'));
    assert.equal((await readFile(writes,'utf8')).trim().split('\n').length,1,'retrieval, repeated tool call and hidden memory marker never duplicate a write');
    const firstArchive = JSON.parse(await readFile(join(dir,'threads.json'),'utf8')).default.messages;
    const drawing = firstArchive.at(-1).toolCalls.find(call => call.name === 'lumi_chibi_render');
    assert.equal(drawing.succeeded,true);
    const drawingReceipt = JSON.parse(drawing.result);
    const actualPNG = await fetch(base + new URL(drawingReceipt.photo.imageURL).pathname, {headers});
    assert.equal(actualPNG.status,200);
    assert.equal(Buffer.from(await actualPNG.arrayBuffer()).subarray(1,4).toString(),'PNG');
    assert.match(stream,/lumi_chibi_render/,'stream completion retains native image receipt');
    const firstCalls=await calls();assert.ok(firstCalls[0].input[0].message.content.some(b=>b.type==='image'));
    assert.ok(firstCalls[0].registered.includes('lumi_chibi_render'), 'drawing tool is exposed through the existing SDK business bridge');
    assert.ok(firstCalls[0].registered.includes('lumi_chibi_read'));
    const originalPersona = await (await fetch(base+'/v1/settings/system-prompt',{headers})).json();
    const editedPersona = originalPersona.prompt + '\n用户编辑入口测试标记';
    assert.equal((await fetch(base+'/v1/settings/system-prompt',{method:'PUT',headers,body:JSON.stringify({prompt:editedPersona,revision:originalPersona.revision})})).status,200);
    const wakeBefore = await (await fetch(base+'/v1/settings/autonomy-prompt',{headers})).json();
    const wakeEdited = '自主唤醒编辑测试标记';
    assert.equal((await fetch(base+'/v1/settings/autonomy-prompt',{method:'PUT',headers,body:JSON.stringify({prompt:wakeEdited,revision:wakeBefore.revision})})).status,200);
    assert.equal((await fetch(base+'/v1/settings/autonomy-prompt',{method:'PUT',headers,body:JSON.stringify({prompt:'旧版本',revision:wakeBefore.revision})})).status,409);
    assert.equal((await fetch(base+'/v1/settings/autonomy-prompt')).status,401);
    const sceneBefore = await (await fetch(base+'/v1/settings/wake-scene-prompt',{headers})).json();
    assert.ok(!sceneBefore.prompt.includes(wakeEdited));
    console.log('harness-test-phase: restart');
    await stop();await start();
    const second=await chat('继续聊天');assert.equal(second.status,200,await second.clone().text());
    const secondCalls=await calls();assert.equal(secondCalls[1].resume,firstCalls[0].session,'HTTP restart uses the persisted checkpoint');
    assert.ok(secondCalls[1].system.includes('用户编辑入口测试标记'), 'persona editor applies on resumed session');
    assert.ok(!JSON.stringify(secondCalls[1].input).includes('自主唤醒编辑测试标记'), 'wake-only rules stay out of daily chat');
    assert.equal((await (await fetch(base+'/v1/settings/autonomy-prompt',{headers})).json()).prompt,wakeEdited, 'wake editor survives restart');
    const imageID = 'a'.repeat(32);
    await (await import('node:fs/promises')).mkdir(join(dir,'chibi-images'),{recursive:true});
    await writeFile(join(dir,'chibi-images',imageID+'.png'),Buffer.from('fixture'));
    assert.equal((await fetch(base+'/v1/chibi/images/'+imageID+'.png')).status,401);
    const ownImage = await fetch(base+'/v1/chibi/images/'+imageID+'.png',{headers});
    assert.equal(ownImage.status,200); assert.equal(ownImage.headers.get('content-type'),'image/png');
    assert.equal(await ownImage.text(),'fixture');
    assert.equal((await fetch(base+'/v1/chibi/images/'+'b'.repeat(32)+'.png',{headers})).status,404);

    const beforeArchive=JSON.parse(await readFile(join(dir,'threads.json'),'utf8')).default.messages;
    console.log('harness-test-phase: failure');
    const failure=await chat('FAIL_HARNESS');assert.equal(failure.status,503);assert.match(await failure.text(),/SYNTHETIC_KIMI_FAILURE/);
    assert.deepEqual(JSON.parse(await readFile(join(dir,'threads.json'),'utf8')).default.messages,beforeArchive);
    assert.match(await readFile(join(dir,'request-failures.json'),'utf8'),/FAIL_HARNESS/);
    assert.equal((await calls()).length,3,'no alternate API request');
    console.log('harness-test-phase: manual-window');
    // Seed an application-owned compacted window without deleting the archive.
    await stop();
    const all=JSON.parse(await readFile(join(dir,'threads.json'),'utf8'));
    const originals=Array.from({length:30},(_,i)=>({id:'tail-'+i,role:i%2?'assistant':'user',content:`最近原话 ${i}：“下次一起看星星”。`,createdAt:new Date(Date.now()-100000+i*1000).toISOString()}));
    all.default.messages.push(...originals);all.default.contextSummary='【情感与关系】我与言言记得合成约定。';all.default.compactedAt=new Date().toISOString();all.default.compactedThroughMessageId=beforeArchive.at(-1).id;all.default.activeContextStartMessageId=originals[0].id;
    await writeFile(join(dir,'threads.json'),JSON.stringify(all));await start();
    const rebuilt=await chat('换窗后继续');assert.equal(rebuilt.status,200,await rebuilt.clone().text());
    const last=(await calls()).at(-1);assert.equal(last.resume,null);assert.match(last.system,/【情感与关系】/);
    const texts=last.input[0].message.content.filter(b=>b.type==='text').map(b=>b.text);
    for(const original of originals)assert.ok(texts.some(text=>text.includes(original.content)),original.id);
    console.log('harness-test-phase: automatic-window');
    // Exercise Lumi's real automatic threshold/distiller/background commit,
    // then inspect the next SDK input rather than asking a model to remember.
    await stop();
    const older=Array.from({length:60},(_,i)=>({id:'auto-'+i,role:i%2?'assistant':'user',content:`原文编号${i}：`+'共同经历'.repeat(125),createdAt:new Date(Date.now()-120000+i*1000).toISOString()}));
    await writeFile(join(dir,'threads.json'),JSON.stringify({default:{id:'default',title:'auto',messages:older,lastMeasuredInputTokens:0}}));
    await writeFile(join(dir,'context-compression.json'),JSON.stringify({triggerTokens:10000}));
    await start();
    console.log('harness-test-phase: trigger');
    const trigger=await chat('触发自动压缩');assert.equal(trigger.status,200,await trigger.clone().text());
    let compressed;
    for(let i=0;i<100;i++){
      compressed=JSON.parse(await readFile(join(dir,'threads.json'),'utf8')).default;
      if(compressed.compactedAt)break;
      await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(compressed.compactedAt,stderr);assert.match(compressed.contextSummary,/【情感与关系】/);
    assert.ok(compressed.messages.length>=62);
    for(const old of older)assert.equal(compressed.messages.find(m=>m.id===old.id)?.content,old.content);
    console.log('harness-test-phase: after-summary');
    const after=await chat('自动换窗后继续');assert.equal(after.status,200,await after.clone().text());
    const afterCall=(await calls()).at(-1);assert.equal(afterCall.resume,null);
    const afterTexts=afterCall.input[0].message.content.filter(b=>b.type==='text').map(b=>b.text);
    for(const old of older.slice(-28))assert.ok(afterTexts.some(text=>text.includes(old.content)),old.id);
    const route=await fetch(base+'/v1/chats/default/runtime',{headers});assert.equal((await route.json()).runtime,'kimi-harness');
    const changed=await fetch(base+'/v1/chats/default/runtime',{method:'PUT',headers,body:JSON.stringify({runtime:'api'})});assert.equal(changed.status,200);
    assert.equal((await changed.json()).runtime,'api');
  } finally {await stop();await rm(dir,{recursive:true,force:true});}
});
