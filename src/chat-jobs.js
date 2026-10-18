import {request as httpRequest} from 'node:http';
import {createHash} from 'node:crypto';
// A mobile connection must not stay open while a slow model thinks. Existing chat
// processing still owns validation, persistence and paid-call idempotency.
export function createChatJobs(port) {
  const jobs = new Map();
  return {
    start(chatID, id, input, authorization) {
      const key=chatID+':'+id, fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      for(const [key,job] of jobs)if(job.expiresAt<Date.now())jobs.delete(key);
      const previous=jobs.get(key);
      if(previous){if(previous.fingerprint!==fingerprint)return {status:409,body:{error:'idempotency_key_reused'}};return {status:202,body:{status:'pending',requestId:id}};}
      if(jobs.size>=100)return {status:503,body:{error:'生成任务较多，请稍后再试。'}};
      const job={fingerprint,status:202,body:{status:'pending',requestId:id},expiresAt:Infinity};jobs.set(key,job);
      const data=JSON.stringify(input);
      const req=httpRequest({hostname:'127.0.0.1',port,path:`/v1/chats/${encodeURIComponent(chatID)}/messages`,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data),'idempotency-key':id,...(authorization?{authorization}:{})}},response=>{
        let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk});
        response.on('end',()=>{try{job.body=JSON.parse(text);job.status=response.statusCode||502}catch{job.body={error:'生成结果无法读取，请刷新聊天记录。'};job.status=502}job.expiresAt=Date.now()+30*60_000});
        response.on('error',fail);
      });
      function fail(){if(job.status!==202)return;job.status=502;job.body={error:'生成连接中断，请刷新聊天记录查看结果。'};job.expiresAt=Date.now()+30*60_000}
      req.on('error',fail);req.end(data);
      return {status:202,body:{status:'pending',requestId:id}};
    },
    read(chatID,id){const job=jobs.get(chatID+':'+id);return job&&job.expiresAt>Date.now()?{status:job.status,body:job.body}:{status:404,body:{error:'生成任务已失效，请刷新聊天记录。'}};}
  };
}
