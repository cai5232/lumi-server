import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('persists disk session; resumes on exact application checkpoint; rebuilds on edits, switches, summary or persona changes', async () => {
  const { root, config } = await fixture(), calls = [];
  const loadSDK = async () => fakeSDK(calls);
  try {
    let runtime = createHarnessRuntime(config,{loadSDK});
    const first = await runtime.run(turn());
    await runtime.finalize(first.receipt, 'archive-checkpoint');
    runtime = createHarnessRuntime(config,{loadSDK}); // backend restart
    const second = await runtime.run(turn({historyHash:'archive-checkpoint'}));
    assert.equal(calls[1].options.resume, 'session-1');
    assert.equal(second.diagnostic.mode,'resume');
    assert.equal(calls[1].capturedInput[0].message.content.length,1,'resume sends only the new turn');
    await runtime.finalize(second.receipt,'archive-checkpoint');
    const edited = await runtime.run(turn({historyHash:'edited-history'}));
    assert.equal(edited.diagnostic.mode,'rebuild');
    await runtime.finalize(edited.receipt,'edited-history');
    const persona = await runtime.run(turn({historyHash:'edited-history',persona:'新的人格'}));
    assert.equal(persona.diagnostic.mode,'rebuild');
    const other = await runtime.run(turn({threadId:'two'}));
    assert.equal(other.diagnostic.mode,'new');
    assert.equal(runtime.diagnostic('one').costUSD,null,'Claude price estimate must not be reported as Kimi billing');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('failed or unexpectedly compacted sessions never resume or call an API fallback', async () => {
  const {root,config}=await fixture(), calls=[];
  try {
    const runtime=createHarnessRuntime(config,{loadSDK:async()=>fakeSDK(calls,{error:true})});
    await assert.rejects(runtime.run(turn()),/synthetic provider failure/);
    const recovered=createHarnessRuntime(config,{loadSDK:async()=>fakeSDK(calls)});
    assert.equal((await recovered.run(turn())).diagnostic.mode,'new');
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
