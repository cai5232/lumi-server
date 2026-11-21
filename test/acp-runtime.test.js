import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAcpRuntime} from '../src/acp/runtime.js';
test('ACP restores checkpoint, preserves system rules and rebuilds after edits',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lumi-acp-'));const calls=[];let count=0;
 const factory=opts=>({start(){return this;},close(){},initialize:async()=>({}),async request(method,params){calls.push({method,params});if(method==='session/new')return {sessionId:'s'+(++count)};if(method==='session/prompt'){opts.onUpdate('session/update',{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP_OK'}}});return {stopReason:'end_turn'};}return {};}});
 const config={root:join(root,'harness'),model:'k3',contextTokens:200000};const runtime=createAcpRuntime(config,{clientFactory:factory});
 const args={threadId:'test',persona:'人格原文',historyHash:'first',messages:[{role:'system',content:'人格原文'},{role:'user',content:'hello'}],executeTool:async()=>{throw new Error('Unexpected tool');}};
 try{
 const first=await runtime.run(args);assert.equal(first.content,'ACP_OK');await runtime.finalize(first.receipt,'next');
 const workspace=calls.find(c=>c.method==='session/new').params.cwd;
 const agent=await readFile(join(workspace,'.kimi-code/agents/agent.md'),'utf8');assert.ok(agent.endsWith('人格原文'));assert.match(agent,/subagents: \[\]/);assert.match(agent,/mcp__lumi__/);
 const restored=await createAcpRuntime(config,{clientFactory:factory}).run({...args,historyHash:'next'});assert.equal(restored.diagnostic.mode,'resume');assert.equal(restored.diagnostic.sessionId,first.diagnostic.sessionId);
 await runtime.finalize(restored.receipt,'after');const edited=await runtime.run({...args,historyHash:'edited'});assert.equal(edited.diagnostic.mode,'new');assert.notEqual(edited.diagnostic.sessionId,first.diagnostic.sessionId);
 }finally{await rm(root,{recursive:true,force:true});}
});
