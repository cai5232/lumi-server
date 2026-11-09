import test from 'node:test';
import assert from 'node:assert/strict';
import {planDistillationChunks,distillContextBatch} from '../src/context-summary.js';
const options={summary:'previous facts',recentContext:'最近的聊天'.repeat(1000),contextLimitTokens:380000,maxOutputTokens:25000};
test('230k Chinese history is summarized in one request without dropping any batch',()=>{
 const chunks=Array.from({length:4},(_,i)=>`START_${i}`+'原'.repeat(57500)+`END_${i}`);
 const planned=planDistillationChunks(chunks,options);
 assert.equal(planned.length,1);assert.equal(planned[0],chunks.join('\n\n'));
});
test('only oversized inputs retain bounded fallback batches',()=>{
 const chunks=Array.from({length:8},()=> '原'.repeat(60000));
 assert.deepEqual(planDistillationChunks(chunks,options),chunks);
 assert.throws(()=>planDistillationChunks(['小材料'],{...options,recentContext:'原'.repeat(380000)}),/超出/);
});
test('summary uses a dedicated task prompt with source and previous summary intact',async()=>{
 let calls=0;
 const result=await distillContextBatch(async req=>{calls++;assert.ok(req.messages[0].content.startsWith('\n\n当前任务'));assert.ok(req.messages[1].content.includes('complete original'));assert.ok(req.messages[1].content.includes('previous facts'));return {content:'<context_summary>完整摘要</context_summary>',finishReason:'end_turn'};},{summary:'previous facts',chunk:'complete original',model:'selected',customProvider:{},maxOutputTokens:25000,index:0,total:1});
 assert.equal(calls,1);assert.equal(result.summary,'完整摘要');
});
