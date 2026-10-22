import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createModelRequestStore} from '../src/model-request-store.js';

test('overview is small and retains all statistics; complete current and legacy details load individually', {timeout: 45000}, async () => {
 const directory=await mkdtemp(join(tmpdir(),'lumi-usage-lazy-'));
 const longPrompt='完整历史上下文'.repeat(40000);
 const record=id=>({id,createdAt:new Date().toISOString(),provider:'custom',model:'test',status:200,durationMs:200,inputTokens:100,outputTokens:20,cachedTokens:80,requestJSON:longPrompt,responseJSON:'完整模型回复'});
 await writeFile(join(directory,'model-request-logs.json'),JSON.stringify({requests:[record('legacy')]}));
 const store=createModelRequestStore(directory);
 for(let i=0;i<24;i++) await store.append(record('new-'+i));
 const metadata=await createModelRequestStore(directory).readMetadata();
 assert.equal(metadata.length,25);assert.ok(metadata.every(item=>!('requestJSON' in item)&&!('responseJSON' in item)));
 assert.equal((await createModelRequestStore(directory).readDetail('legacy')).requestJSON,longPrompt);
 const probe=createServer(),port=20000+Math.floor(Math.random()*10000);
 await new Promise(resolve=>probe.listen(port,'127.0.0.1',resolve));await new Promise(resolve=>probe.close(resolve));
 const base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['src/index.js'],{env:{...process.env,PORT:String(port),LUMI_DATA_DIR:directory,LUMI_PUSH_API_TOKEN:'test',LUMI_CACHE_KEEPALIVE_ENABLED:'false',LUMI_PROMISE_ALARM_ENABLED:'false',DUETTO_INTERNAL_PORT:'0'},stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',chunk=>errors+=chunk);
 const headers={authorization:'Bearer test'};
 try {
  let ready=false;for(let i=0;i<300;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(ready,errors);
  const summaryResponse=await fetch(base+'/v1/usage/requests?summary=1',{headers});
  assert.equal(summaryResponse.status,200);
  const summaryText=await summaryResponse.text(),summary=JSON.parse(summaryText);
  assert.equal(summary.requests.length,20);assert.equal(summary.activity.retainedRequests,25);
  assert.ok(summary.requests.every(item=>item.requestJSON===undefined&&item.responseJSON===undefined));
  const full=await(await fetch(base+'/v1/usage/requests',{headers})).json();
  assert.deepEqual(summary.days,full.days);assert.deepEqual(summary.week,full.week);assert.deepEqual(summary.activity.days,full.activity.days);
  assert.ok(Buffer.byteLength(summaryText)<30000);
  assert.ok(Buffer.byteLength(summaryText)*100<Buffer.byteLength(JSON.stringify(full)),'overview is over 99% smaller for long contexts');
  for(const id of ['new-23','legacy']) {
   const detail=await fetch(base+'/v1/usage/requests/'+id,{headers});assert.equal(detail.status,200);
   const body=await detail.json();assert.equal(body.requestJSON,longPrompt);assert.equal(body.responseJSON,'完整模型回复');
  }
  assert.equal((await fetch(base+'/v1/usage/requests/new-23')).status,401);
  assert.equal((await fetch(base+'/v1/usage/requests/missing',{headers})).status,404);
 } finally {
  if(child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}
  await rm(directory,{recursive:true,force:true});
 }
});
