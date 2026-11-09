import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {LumiDayflow} from '../src/dayflow-lumi.js';
const now=Date.parse('2026-11-09T12:00:00Z');
const transcript=Array.from({length:24},(_,i)=>({id:String(i),role:i%2?'assistant':'user',content:('这一段是当天的真实原话。').repeat(130)+i,createdAt:new Date(now-(24-i)*60000).toISOString(),modelContent:'PRIVATE_RETRIEVAL_NOT_DURABLE'}));
const options={thread:{id:'default',compactedThroughMessageId:'legacy-end',lastMeasuredInputTokens:0},archive:transcript,input:'还在吗',overheadTokens:2000,model:'selected',customProvider:{key:'test'}};
const summary={entries:[{type:'relation',fact:'她希望重要的约定被记住',temporal:'evergreen',status:'stable',sourceAt:'2026-11-09T11:00:00Z'}],bridge:'关于约定的谈话尚未结束'};
test('230000 trigger is preserved; original archive and hidden recalled context never change',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-dayflow-'));try{let calls=0;const adapter=new LumiDayflow({directory,triggerTokens:()=>230000,now:()=>now,callModel:async()=>{calls++;throw Error('must not call');}});const before=JSON.stringify(transcript);
 const projected=await adapter.project(options);assert.equal(calls,0);assert.ok(!JSON.stringify(projected).includes('PRIVATE_RETRIEVAL_NOT_DURABLE'));assert.equal(JSON.stringify(transcript),before);assert.equal((await adapter.status(options.thread)).budget.activateTokens,230000);
 const restarted=new LumiDayflow({directory,triggerTokens:()=>230000,now:()=>now,callModel:async()=>{}});await restarted.load();assert.equal((await restarted.project(options)).history.length,24);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('rotation replaces working state, keeps a verbatim tail, and survives restart without re-summarizing',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-dayflow-'));try{let calls=0;const adapter=new LumiDayflow({directory,triggerTokens:()=>230000,now:()=>now,callModel:async request=>{calls++;assert.equal(request.maxOutputTokens,4000);assert.ok(request.signal);assert.ok(!JSON.stringify(request.messages).includes('PRIVATE_RETRIEVAL_NOT_DURABLE'));return {content:JSON.stringify(summary),finishReason:'stop'};}});
 const thread={...options.thread,lastMeasuredInputTokens:230001};const projected=await adapter.project({...options,thread});assert.equal(calls,1);assert.ok(projected.rotated);assert.match(JSON.stringify(projected.history),/dayflow_state/);assert.ok(projected.history.length<24);assert.equal(transcript.length,24);
 const restarted=new LumiDayflow({directory,triggerTokens:()=>230000,now:()=>now,callModel:async()=>{throw Error('should reuse committed state');}});const next=await restarted.project(options);assert.equal(next.rotated,false);assert.match(JSON.stringify(next.history),/约定/);assert.equal((await restarted.status(thread)).rotations,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('summary failure uses last committed projection, records a real failure status and does not retry during cooldown',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-dayflow-'));try{let calls=0;const adapter=new LumiDayflow({directory,triggerTokens:()=>230000,now:()=>now,callModel:async()=>{calls++;throw Error('relay unavailable');}});
 const first=await adapter.project({...options,thread:{...options.thread,lastMeasuredInputTokens:230001}});assert.equal(calls,1);assert.equal(first.history.length,24);assert.match(first.warning,/relay unavailable/);assert.equal((await adapter.status(options.thread)).lastRun.status,'failed');
 await adapter.project({...options,thread:{...options.thread,lastMeasuredInputTokens:230001}});assert.equal(calls,1);assert.equal((await adapter.store.load(adapter.key(options.thread))).covered,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('story and disabled modes are explicit and persist across restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-dayflow-'));try{const adapter=new LumiDayflow({directory,triggerTokens:()=>230000,now:()=>now});await adapter.configure({mode:'story'});assert.equal((await adapter.status(options.thread)).compactionEnabled,false);const restart=new LumiDayflow({directory,triggerTokens:()=>230000,now:()=>now});await restart.load();assert.equal(restart.config.mode,'story');await assert.rejects(restart.configure({mode:'unknown'}));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('capsule cache prefix stays stable between rotations while observation time advances',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-dayflow-'));try{let clock=now;const adapter=new LumiDayflow({directory,triggerTokens:()=>230000,now:()=>clock,callModel:async()=>({content:JSON.stringify(summary),finishReason:'stop'})});
 const first=await adapter.project({...options,thread:{...options.thread,lastMeasuredInputTokens:230001}});clock+=60000;const second=await adapter.project(options);assert.equal(second.history[0].content,first.history[0].content);
 }finally{await rm(directory,{recursive:true,force:true});}
});
