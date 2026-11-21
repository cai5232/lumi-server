import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { harnessEnvironment } from '../src/harness-config.js';
import { createHarnessRuntime } from '../src/harness-runtime.js';

test('real pinned SDK: project instructions, streamed tool loop, image blocks, disk resume', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumi-sdk-contract-'));
  const bodies = [];
  let toolCalls = 0;
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!req.url.includes('/messages')) { res.writeHead(200); res.end('{}'); return; }
    const body = JSON.parse(raw); bodies.push(body);
    const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
    const hasResult = JSON.stringify(lastUser).includes('tool_result');
    const blocks = hasResult ? [{ type: 'text', text: 'CONTRACT_OK' }] : [{ type: 'tool_use', id: `tool_contract_${bodies.length}`, name: body.tools.find(t => t.name.includes('probe_echo'))?.name, input: { value: 'contract' } }];
    const stop = hasResult ? 'end_turn' : 'tool_use';
    const usage = { input_tokens: 100, output_tokens: 8, cache_read_input_tokens: 64, cache_creation_input_tokens: 0 };
    if (!body.stream) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ id: 'msg_contract', type:'message', role:'assistant', model: body.model, content:blocks, stop_reason:stop, usage })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', { message: { id: `msg_${bodies.length}`, type:'message', role:'assistant', model:body.model, content:[], stop_reason:null, usage:{...usage,cache_read_input_tokens:0,output_tokens:0} } });
    for (const [index, b] of blocks.entries()) {
      emit('content_block_start', { index, content_block: b.type === 'text' ? {type:'text',text:''} : {...b,input:{}} });
      emit('content_block_delta', { index, delta: b.type === 'text' ? {type:'text_delta',text:b.text} : {type:'input_json_delta',partial_json:JSON.stringify(b.input)} });
      emit('content_block_stop', { index });
    }
    emit('message_delta', { delta: {stop_reason:stop,stop_sequence:null}, usage });
    emit('message_stop', {}); res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const env = harnessEnvironment({ root, baseURL: `http://127.0.0.1:${upstream.address().port}`, key:'synthetic-key',model:'kimi-for-coding',contextTokens:262144 });
  await mkdir(env.CLAUDE_CONFIG_DIR, {recursive:true});
  await writeFile(join(root,'CLAUDE.md'), 'PROJECT_VERBATIM_MARKER\n');
  const makeTools = () => createSdkMcpServer({ name:'probe',tools:[tool('probe_echo','Echo',{value:z.string()},async ({value})=>{ toolCalls++; return {content:[{type:'text',text:value}]}; })] });
  const events = [];
  let session;
  try {
    for (let turn = 0; turn < 2; turn++) {
      const q = query({ prompt:(async function*(){ yield {type:'user',message:{role:'user',content:[{type:'text',text:`TURN_${turn}`}, ...(turn === 0 ? [{type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhT8AAAAASUVORK5CYII='}}] : [])]},parent_tool_use_id:null}; })(), options: {
        cwd:root,env,model:'kimi-for-coding',systemPrompt:'SYSTEM_VERBATIM_MARKER',settingSources:['project'],tools:[],skills:[],
        strictMcpConfig:true,mcpServers:{probe:makeTools()},allowedTools:['mcp__probe__probe_echo'],permissionMode:'dontAsk',
        settings:{autoCompactEnabled:false},includePartialMessages:true,maxTurns:4,...(session?{resume:session}:{})
      } });
      try {
        for await (const m of q) {
          events.push(m);
          if (m.type==='system'&&m.subtype==='init') { if (session) assert.equal(m.session_id,session); session=m.session_id; }
          if (m.type==='result') assert.equal(m.is_error,false,JSON.stringify(m));
        }
      } finally { q.close(); }
    }
    assert.ok(session);
    assert.ok(toolCalls >= 2);
    assert.ok(events.some(m=>m.type==='stream_event'&&m.event?.delta?.type==='text_delta'));
    assert.match(JSON.stringify(bodies[0]), /PROJECT_VERBATIM_MARKER/);
    assert.match(JSON.stringify(bodies[0].system), /SYSTEM_VERBATIM_MARKER/);
    assert.match(JSON.stringify(bodies[0].messages), /"type":"image"/);
    assert.match(JSON.stringify(bodies.at(-1).messages), /TURN_0/);
    assert.match(JSON.stringify(bodies.at(-1).messages), /TURN_1/);
    assert.ok(bodies.every(b=>b.tools.every(t=>t.name.includes('probe_echo') || t.name === 'DeferredToolPlaceholder')),  'No built-in programming tools');
    const config = {root:join(root,'runtime'),enabled:true,key:'synthetic-key',baseURL:`http://127.0.0.1:${upstream.address().port}`,model:'kimi-for-coding',contextTokens:262144,maxTurns:4,keepaliveIntervalMs:1};
    const makeRuntime = () => createHarnessRuntime(config);
    let runtime = makeRuntime();
    let businessExecutions = 0;
    const request = {threadId:'thread',persona:'PERSONA_EXACT',historyHash:'empty',messages:[{role:'system',content:'PERSONA_EXACT'},{role:'user',content:'RUNTIME_0'}],
      tools:[{name:'probe_echo',description:'Echo',input_schema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}],
      executeTool: async(_name,args)=>{businessExecutions++;return {echo:args.value};}};
    const generated = await runtime.run(request);
    assert.equal(generated.content,'CONTRACT_OK');
    await runtime.finalize(generated.receipt,'after-first');
    runtime = makeRuntime();
    const resumed = await runtime.run({...request,historyHash:'after-first',messages:[{role:'system',content:'PERSONA_EXACT'},{role:'user',content:'RUNTIME_1'}]});
    assert.equal(resumed.diagnostic.mode,'resume');
    assert.equal(resumed.diagnostic.sessionId,generated.diagnostic.sessionId);
    assert.ok(resumed.lastUsage.cache_read_input_tokens>0);
    await runtime.finalize(resumed.receipt,'after-second');
    const projectRoot = join(config.root,'config','projects');
    const sessionFile = (await readdir(projectRoot,{recursive:true})).find(p=>p.endsWith(resumed.diagnostic.sessionId+'.jsonl'));
    assert.ok(sessionFile);
    const transcript = await readFile(join(projectRoot,sessionFile),'utf8');
    const bodyCount = bodies.length;
    const executionsBeforeWarm = businessExecutions;
    const warm = await runtime.warm('thread');
    assert.equal(warm.attempted,true,JSON.stringify(warm));
    assert.equal(warm.hit,true);
    assert.equal(warm.readTokens,64,'Use the final streamed cache usage');
    assert.equal(businessExecutions,executionsBeforeWarm,'Warming cannot execute business tools');
    assert.equal(await readFile(join(projectRoot,sessionFile),'utf8'),transcript,'Warm must not mutate primary transcript');
    assert.deepEqual(bodies[bodyCount].tools,bodies[bodyCount-1].tools,'Warm keeps the same tool prefix');
    assert.match(JSON.stringify(bodies[bodyCount]), /"ttl":"1h"/);
    assert.match(JSON.stringify(bodies[bodyCount].messages), /RUNTIME_0/);
    assert.match(JSON.stringify(bodies[bodyCount].messages), /RUNTIME_1/);
    await rm(join(config.root,'config','projects'),{recursive:true,force:true});
    const recovered=await runtime.run({...request,historyHash:'after-second',messages:[{role:'system',content:'PERSONA_EXACT'},{role:'user',content:'RUNTIME_0'},{role:'assistant',content:'CONTRACT_OK'},{role:'user',content:'RECOVERED_TURN'}]});
    assert.equal(recovered.diagnostic.mode,'rebuild');
    assert.equal(recovered.content,'CONTRACT_OK');
    assert.notEqual(recovered.diagnostic.sessionId,resumed.diagnostic.sessionId);
  } finally { upstream.closeAllConnections(); await new Promise(resolve=>upstream.close(resolve)); await rm(root,{recursive:true,force:true}); }
});
