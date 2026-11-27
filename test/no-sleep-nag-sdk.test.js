import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessRuntime } from '../src/harness-runtime.js';

test('real SDK Stop hook rewrites once in the same Session, never streams rejected drafts and blocks repeated nags', {timeout:60000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'lumi-no-sleep-sdk-'));
  const bodies=[];let alwaysBad=false;
  const upstream=createServer(async(req,res)=>{
    let raw='';for await(const b of req)raw+=b;
    if(!req.url.includes('/messages')){res.writeHead(200);res.end('{}');return;}
    const body=JSON.parse(raw);bodies.push(body);
    const feedback=JSON.stringify(body.messages).includes('【禁催睡 Hook】');
    const text=alwaysBad||!feedback?'早点睡，晚安。':'那我陪你继续聊。';
    const usage={input_tokens:100,output_tokens:10,cache_read_input_tokens:64};
    if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'m'+bodies.length,type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',usage}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    emit('message_start',{message:{id:'m'+bodies.length,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,usage:{...usage,output_tokens:0}}});
    emit('content_block_start',{index:0,content_block:{type:'text',text:''}});
    emit('content_block_delta',{index:0,delta:{type:'text_delta',text}});
    emit('content_block_stop',{index:0});
    emit('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage});
    emit('message_stop',{});res.end();
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const config={root,enabled:true,key:'local-mock-only',baseURL:`http://127.0.0.1:${upstream.address().port}`,model:'kimi-for-coding',contextTokens:262144,maxTurns:4,effort:'max'};
  const args={threadId:'chat',scope:'chat',persona:'原有人格',historyHash:'archive',archiveMessages:[],messages:[{role:'system',content:'原有人格'},{role:'user',content:'我想继续聊'}],noSleepNag:{userText:'我想继续聊'}};
  const events=[];
  try{
    let runtime=createHarnessRuntime(config);
    const first=await runtime.run({...args,onEvent:e=>events.push(e)});
    assert.equal(first.content,'那我陪你继续聊。');
    assert.equal(first.diagnostic.noSleepNag.rewrites,1);assert.equal(first.diagnostic.calls,2);
    assert.equal(bodies.length,2,'one rewrite, no replacement-provider calls');
    assert.ok(events.filter(e=>e.type==='text').every(e=>!e.content.includes('晚安')&&!e.content.includes('早点睡')));
    assert.ok(events.some(e=>e.type==='text'&&e.content==='那我陪你继续聊。'));
    assert.deepEqual(bodies[0].system,bodies[1].system,'rewrite feedback is a suffix, not a persona edit');
    assert.deepEqual(bodies[0].tools,bodies[1].tools);
    await runtime.finalize(first.receipt,'archive',[]);
    runtime=createHarnessRuntime(config);alwaysBad=true;
    const bedtime=await runtime.run({...args,noSleepNag:{userText:'我要睡了，晚安'},messages:[args.messages[0],{role:'user',content:'我要睡了，晚安'}]});
    assert.equal(bedtime.content,'早点睡，晚安。');assert.equal(bedtime.diagnostic.noSleepNag.rewrites,0);
    assert.equal(bedtime.diagnostic.sessionId,first.diagnostic.sessionId);
    await runtime.finalize(bedtime.receipt,'archive',[]);
    const before=bodies.length,blockedEvents=[];
    await assert.rejects(runtime.run({...args,threadId:'blocked',onEvent:e=>blockedEvents.push(e)}),e=>{
      assert.equal(e.code,'sleep_nag_blocked');assert.equal(e.statusCode,422);
      assert.equal(e.harnessDiagnostic.calls,2);assert.ok(e.usage.input_tokens>0);return true;
    });
    assert.equal(bodies.length-before,2,'repeated violation does not loop');
    assert.ok(!blockedEvents.some(e=>e.type==='text'),'no invalid final or intermediate draft leaks');
    // Stop rewrites cannot repeat business side effects, even if the SDK tries.
    const optionsCalls=[];
    const fake={tool:(...a)=>a,createSdkMcpServer:o=>o,query({options}){optionsCalls.push(options);return{close(){},async *[Symbol.asyncIterator](){
      yield{type:'system',subtype:'init',apiKeySource:'ANTHROPIC_API_KEY',session_id:'fake'};
      yield{type:'assistant',message:{id:'before-tool',content:[{type:'text',text:'<memory>合成记忆</memory>'}]}};
      yield{type:'assistant',message:{id:'rejected',content:[{type:'text',text:'晚安。'}]}};
      assert.equal((await options.hooks.Stop[0].hooks[0]({last_assistant_message:'晚安。',stop_hook_active:false})).decision,'block');
      const denied=await options.hooks.PreToolUse[0].hooks[0]({tool_name:'mcp__lumi__send_mail'});
      assert.equal(denied.hookSpecificOutput.permissionDecision,'deny');
      const tool=options.mcpServers.lumi.tools[0];const result=await tool[3]({});assert.equal(result.isError,true);
      yield{type:'assistant',message:{id:'fake',content:[{type:'text',text:'陪你。'}]}};
      yield{type:'result',subtype:'success',is_error:false,session_id:'fake',result:'陪你。',usage:{input_tokens:1}};
    }}}};
    const fakeRuntime=createHarnessRuntime({...config,root:join(root,'fake')},{loadSDK:async()=>fake});
    const withMemory=await fakeRuntime.run({...args,tools:[{name:'send_mail',input_schema:{type:'object',properties:{}}}],executeTool:()=>{throw Error('must not execute twice');}});
    assert.match(withMemory.content,/<memory>合成记忆<\/memory>/);assert.ok(!withMemory.content.includes('晚安'));assert.match(withMemory.content,/陪你/);
  }finally{upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(root,{recursive:true,force:true});}
});
