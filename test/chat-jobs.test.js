import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createChatJobs} from '../src/chat-jobs.js';
test('a slow generation outlives the short submit connection and is retrieved exactly once',async()=>{
 let calls=0;
 const server=createServer(async(req,res)=>{calls++;assert.equal(req.headers['idempotency-key'],'long-request-123');assert.equal(req.headers.authorization,'Bearer fake');for await(const _ of req){}await new Promise(r=>setTimeout(r,180));res.setHeader('content-type','application/json');res.end('{"assistantMessage":{"content":"完成"}}')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const jobs=createChatJobs(server.address().port),input={content:'测试'};
  assert.equal(jobs.start('default','long-request-123',input,'Bearer fake').status,202);
  assert.equal(jobs.read('default','long-request-123').status,202);
  assert.equal(jobs.start('default','long-request-123',input,'Bearer fake').status,202);
  assert.equal(jobs.start('default','long-request-123',{content:'不同正文'},'Bearer fake').status,409);
  let job;
  for(let i=0;i<40;i++){job=jobs.read('default','long-request-123');if(job.status!==202)break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(job.status,200);assert.equal(job.body.assistantMessage.content,'完成');assert.equal(calls,1);
  assert.equal(jobs.read('another','long-request-123').status,404);
 }finally{await new Promise(r=>server.close(r))}
});
