import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessRuntime, reconstructInput } from '../src/harness-runtime.js';
import { fingerprint, historyFingerprint } from '../src/harness-state.js';
import { harnessConfig, harnessEnvironment } from '../src/harness-config.js';
import { harnessContextPolicy } from '../src/harness-context.js';
import { createHarnessRoutes } from '../src/harness-routes.js';

function fakeSDK(calls, { error = false, compact = false, pause = null } = {}) {
  return { tool: (...args) => args, createSdkMcpServer: options => options, query(args) {
    calls.push(args);
    return { close() {}, async *[Symbol.asyncIterator]() {
      const input = []; for await (const m of args.prompt) input.push(m); args.capturedInput = input;
      yield { type: 'system', subtype: 'init', apiKeySource:'ANTHROPIC_API_KEY', session_id: args.options.resume || 'session-'+calls.length };
      if (pause) await pause;
      if (compact) yield { type: 'system', subtype: 'compact_boundary' };
      if (error) throw new Error('synthetic provider failure');
      yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'm', usage: { input_tokens: 10, cache_read_input_tokens: 100 } } } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '回复' } } };
      yield { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: '回复' }] } };
      yield { type: 'result', session_id: args.options.resume || 'session-'+calls.length, subtype: 'success', stop_reason: 'end_turn', is_error: false, usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 2 } };
    } };
  } };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lumi-harness-test-'));
  return { root, config: { enabled:true,key:'test-key',baseURL:'https://api.kimi.com/coding/',model:'kimi-for-coding',contextTokens:262144,maxTurns:8,root } };
}
const turn = (overrides = {}) => ({ threadId:'one', persona:'人格', historyHash:historyFingerprint([]), messages:[{role:'system',content:'人格'},{role:'user',content:'新消息'}], ...overrides });

test('persists disk session; resumes on exact application checkpoint; continues through edits, switches, summary or persona changes', async () => {
  const { root, config } = await fixture(), calls = [];
  const loadSDK = async () => fakeSDK(calls);
  try {
    let runtime = createHarnessRuntime(config,{loadSDK});
    const first = await runtime.run(turn());
    const personaPath=join(calls[0].options.cwd,'prompts','effective-persona.md');
    const originalMtime=(await stat(personaPath)).mtimeMs;
    await runtime.finalize(first.receipt, 'archive-checkpoint');
    runtime = createHarnessRuntime(config,{loadSDK}); // backend restart
    const second = await runtime.run(turn({historyHash:'archive-checkpoint'}));
    assert.equal(calls[1].options.resume, 'session-1');
    assert.equal(second.diagnostic.mode,'resume');
    assert.equal((await stat(personaPath)).mtimeMs,originalMtime,'unchanged rules must not trigger file-change context on resume');
    assert.equal(calls[1].capturedInput[0].message.content.length,1,'resume sends only the new turn');
    await runtime.finalize(second.receipt,'archive-checkpoint');
    const edited = await runtime.run(turn({historyHash:'edited-history'}));
    assert.equal(edited.diagnostic.mode,'resume');
    await runtime.finalize(edited.receipt,'edited-history');
    const persona = await runtime.run(turn({historyHash:'edited-history',persona:'新的人格'}));
    assert.equal(persona.diagnostic.mode,'resume');
    const other = await runtime.run(turn({threadId:'two'}));
    assert.equal(other.diagnostic.mode,'new');
    assert.equal(runtime.diagnostic('one').costUSD,null,'Claude price estimate must not be reported as Kimi billing');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('provider failures retain the session; unexpected compaction fails without an API fallback', async () => {
  const {root,config}=await fixture(), calls=[];
  try {
    const runtime=createHarnessRuntime(config,{loadSDK:async()=>fakeSDK(calls,{error:true})});
    await assert.rejects(runtime.run(turn()),/synthetic provider failure/);
    const recovered=createHarnessRuntime(config,{loadSDK:async()=>fakeSDK(calls)});
    assert.equal((await recovered.run(turn())).diagnostic.mode,'resume');
    const compact=createHarnessRuntime(config,{loadSDK:async()=>fakeSDK(calls,{compact:true})});
    await assert.rejects(compact.run(turn()),/非预期的原生压缩/);
    assert.equal(calls.length,3,'one selected-provider invocation per turn');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('concurrent calls for one session are rejected; code tools, independent memory and foreign credentials stay disabled', async () => {
  const {root,config}=await fixture(),calls=[];
  let unblock; const pause=new Promise(resolve=>{unblock=resolve;});
  const runtime=createHarnessRuntime(config,{loadSDK:async()=>fakeSDK(calls,{pause})});
  try {
    const first=runtime.run(turn());
    await assert.rejects(runtime.run(turn()),/Session 正忙/);
    unblock();await first;
    const options=calls[0].options;
    assert.deepEqual(options.tools,[]);assert.deepEqual(options.skills,[]);
    assert.equal(options.strictMcpConfig,true);assert.equal(options.settings.autoCompactEnabled,false);
    assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,'1');
    assert.equal((await options.hooks.PreCompact[0].hooks[0]()).decision,'block');
    assert.equal((await options.hooks.PreToolUse[0].hooks[0]({tool_name:'Bash'})).hookSpecificOutput.permissionDecision,'deny');
    const env=harnessEnvironment(config,{PATH:'/bin',ANTHROPIC_AUTH_TOKEN:'other',CLAUDE_CODE_OAUTH_TOKEN:'other',AWS_SECRET_ACCESS_KEY:'other'});
    assert.equal(env.ANTHROPIC_AUTH_TOKEN,undefined);assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(env.AWS_SECRET_ACCESS_KEY,undefined);
  } finally {unblock();await rm(root,{recursive:true,force:true});}
});

test('reconstructed payload includes exact recent original text, evidence and image bytes; 256K model clamps old 300K threshold',()=>{
  const history=Array.from({length:30},(_,i)=>({role:i%2?'assistant':'user',content:`原话 ${i}：\n“不要改动”`}));
  const image='data:image/png;base64,AABB';history[0].images=[image];
  const input=reconstructInput([...history,{role:'user',content:'现在'}]);
  for(const h of history)assert.ok(input.some(b=>b.text===h.content));
  assert.ok(input.some(b=>b.type==='image'&&b.source.data==='AABB'));
  const policy=harnessContextPolicy({contextTokens:262144},{triggerTokensEstimate:300000});
  assert.ok(policy.triggerTokens<262144);assert.equal(policy.requestedTriggerTokens,300000);
  assert.throws(()=>harnessConfig({LUMI_KIMI_CODE_BASE_URL:'https://api.anthropic.com/'}),/official/);
});

test('per-thread route is persistent and disabled/absent Kimi fails closed',async()=>{
  const {root,config}=await fixture();const path=join(root,'routes.json');
  try {
    const routes=createHarnessRoutes(path,config,{});
    assert.equal(await routes.route('one'),null);
    await routes.save('one','kimi-harness');
    assert.equal((await createHarnessRoutes(path,config,{}).route('one')).customProvider.runtime,'kimi-harness');
    assert.equal(await routes.route('two'),null);
    await assert.rejects(createHarnessRoutes(path,{...config,enabled:false},{}).route('one'),/尚未启用/);
    await routes.save('one','api');assert.equal(await routes.route('one'),null);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('budget guard includes project instructions before issuing a model request',async()=>{
  const {root,config}=await fixture(),calls=[];
  try {
    const runtime=createHarnessRuntime({...config,contextTokens:20000},{loadSDK:async()=>fakeSDK(calls)});
    const persona='原'.repeat(5000);
    await assert.rejects(runtime.run(turn({persona,messages:[{role:'system',content:persona},{role:'user',content:'继续'}]})),/上下文预算/);
    assert.equal(calls.length,0,'do not issue an underbudgeted request that omits CLI-injected rules');
  } finally {await rm(root,{recursive:true,force:true});}
});

 test('K3 deployment defaults use the requested 200K window',()=>{
 const config=harnessConfig({});
 assert.equal(config.model,'k3');assert.equal(config.contextTokens,200000);
 const policy=harnessContextPolicy(config,{triggerTokensEstimate:300000});
 assert.equal(policy.inputBudget,188000);assert.equal(policy.triggerTokens,150400);
 });

test('SDK model choice persists per thread while runtime switching preserves it',async()=>{
 const {root,config}=await fixture();
 try{
  const path=join(root,'routes.json');const routes=createHarnessRoutes(path,config,{});
  await routes.save('a','kimi-harness','kimi-for-coding');
  assert.equal((await routes.route('a')).model,'kimi-for-coding');
  assert.equal(await routes.model('b'),config.model);
  await routes.save('a','api');await routes.save('a','kimi-harness');
  assert.equal((await createHarnessRoutes(path,config,{}).route('a')).model,'kimi-for-coding');
  await assert.rejects(routes.save('a','kimi-harness','unavailable'),/invalid_sdk_model/);
  assert.equal((await routes.route('a')).model,'kimi-for-coding');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('wake sessions resume after restart independently of chat checkpoints, with an explicit diagnostic reason', async () => {
  const {root,config}=await fixture(),calls=[];
  const loadSDK=async()=>fakeSDK(calls);
  try {
    let runtime=createHarnessRuntime(config,{loadSDK});
    const chat=await runtime.run(turn());
    await runtime.finalize(chat.receipt,'chat-archive');
    const wake=await runtime.run(turn({scope:'wake',historyHash:'chat-archive',ephemeral:false}));
    assert.equal(wake.diagnostic.mode,'new');
    assert.equal(wake.diagnostic.scope,'wake');
    await runtime.finalize(wake.receipt,'persisted-wake-archive');
    runtime=createHarnessRuntime(config,{loadSDK});
    const next=await runtime.run(turn({scope:'wake',historyHash:'persisted-wake-archive',ephemeral:false}));
    assert.equal(next.diagnostic.mode,'resume');
    assert.equal(next.diagnostic.sessionReason,'continued_session');
    assert.equal(calls[2].options.resume,wake.diagnostic.sessionId);
    assert.notEqual(calls[2].options.resume,chat.diagnostic.sessionId);
    await runtime.finalize(next.receipt,'persisted-wake-archive');
    const changed=await runtime.run(turn({scope:'wake',historyHash:'edited-or-compacted-archive'}));
    assert.equal(changed.diagnostic.mode,'resume');
    assert.equal(changed.diagnostic.sessionReason,'continued_session');
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('SDK effort defaults to low and changes continue the old session', async () => {
  assert.equal(harnessConfig({}).effort,'low');
  assert.equal(harnessConfig({LUMI_HARNESS_EFFORT:'high'}).effort,'high');
  assert.throws(()=>harnessConfig({LUMI_HARNESS_EFFORT:'medium'}),/low, high or max/);
  const {root,config}=await fixture(),calls=[];
  const loadSDK=async()=>fakeSDK(calls);
  try {
    const old=createHarnessRuntime({...config,effort:'max'},{loadSDK});
    const first=await old.run(turn());await old.finalize(first.receipt,'same-archive');
    const low=createHarnessRuntime({...config,effort:'low'},{loadSDK});
    const next=await low.run(turn({historyHash:'same-archive'}));
    assert.equal(calls[1].options.effort,'low');
    assert.equal(calls[1].options.env.CLAUDE_CODE_EFFORT_LEVEL,'low');
    assert.equal(next.diagnostic.effort,'low');
    assert.equal(next.diagnostic.sessionReason,'definition_updated_in_place');
    await low.finalize(next.receipt,'same-archive');
    const continued=await low.run(turn({historyHash:'same-archive'}));
    assert.equal(continued.diagnostic.mode,'resume');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('only application compaction replaces an existing session; history/config changes are synchronized in place', async()=>{
 const {root,config}=await fixture(),calls=[],loadSDK=async()=>fakeSDK(calls);
 try{
  let runtime=createHarnessRuntime(config,{loadSDK});
  const old=[{id:'a',role:'user',content:'旧原话'},{id:'b',role:'assistant',content:'旧回复'}];
  const first=await runtime.run(turn({archiveMessages:old,historyHash:historyFingerprint(old),compactedAt:null}));
  await runtime.finalize(first.receipt,historyFingerprint(old),old);
  const edited=[{...old[0],content:'更正后的原话'},{id:'c',role:'assistant',content:'唤醒后新增'}];
  runtime=createHarnessRuntime({...config,model:'k3',effort:'high'},{loadSDK});
  const continued=await runtime.run(turn({archiveMessages:edited,historyHash:historyFingerprint(edited),compactedAt:null,persona:'更新人格',tools:[{name:'new_business_tool',input_schema:{type:'object',properties:{}}}]}));
  assert.equal(continued.diagnostic.mode,'resume');assert.equal(continued.diagnostic.sessionId,first.diagnostic.sessionId);
  const payload=JSON.stringify(calls.at(-1).capturedInput);
  assert.match(payload,/更正后的原话/);assert.match(payload,/旧回复/);assert.match(payload,/唤醒后新增/);assert.match(payload,/lumi_archive_changes/);
  await runtime.finalize(continued.receipt,historyFingerprint(edited),edited);
  const compacted=await runtime.run(turn({archiveMessages:edited,historyHash:historyFingerprint(edited),compactedAt:'2026-11-22T12:00:00Z'}));
  assert.equal(compacted.diagnostic.mode,'rebuild');assert.equal(compacted.diagnostic.sessionReason,'application_compaction');
  assert.equal(calls.at(-1).options.resume,undefined);
  await runtime.finalize(compacted.receipt,historyFingerprint(edited),edited);
  const next=await runtime.run(turn({archiveMessages:edited,historyHash:historyFingerprint(edited),compactedAt:'2026-11-22T12:00:00Z'}));
  assert.equal(next.diagnostic.mode,'resume');
 }finally{await rm(root,{recursive:true,force:true});}
});
