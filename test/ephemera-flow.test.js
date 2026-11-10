import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const listen=async s=>{await new Promise(r=>s.listen(0,'127.0.0.1',r));return s.address().port;};
for(const format of ['openai','anthropic'])test(`${format} can write a date and returns a sealed chat trace`,async()=>{
 const folder=await mkdtemp(join(tmpdir(),'lumi-ephemera-'));let calls=0;let sawResult=false;let requestedName;
 const mcp=createServer(async(req,res)=>{if(req.url==='/context'){res.setHeader('content-type','text/plain');return res.end('约会待办 0 件');}let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw||'{}');res.setHeader('content-type','application/json');
 if(b.id===undefined){res.writeHead(202);return res.end();}
 let result={};
 if(b.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};
 if(b.method==='tools/list')result={tools:[{name:'date_edit',inputSchema:{type:'object'}}]};
 if(b.method==='tools/call'){calls++;assert.equal(b.params.name,'date_edit');assert.equal(b.params.arguments.note,'secret itinerary');result={content:[{type:'text',text:'secret upcoming place'}]};}
 res.end(JSON.stringify({jsonrpc:'2.0',id:b.id,result}));
 });const mcpPort=await listen(mcp);
 await writeFile(join(folder,'mcp-clients.json'),JSON.stringify({servers:[{id:'ephemera-date',name:'约会纸品',url:'https://ephemera-date.107.174.137.23.sslip.io/mcp',enabled:true,headers:{Authorization:'Bearer fake-ai-token'},tools:[{name:'date_edit',description:'Edit a date',inputSchema:{type:'object',properties:{note:{type:'string'}}}}]}]}));
 const provider=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;res.setHeader('content-type','application/json');if(req.method==='GET')return res.end('[]');const body=JSON.parse(raw||'{}');
 const listed=format==='openai'?body.tools?.find(t=>t.function?.name?.endsWith('_date_edit'))?.function:body.tools?.find(t=>t.name?.endsWith('_date_edit'));
 const containsResults=JSON.stringify(body.messages||[]).includes('secret upcoming place');
 let content='{"events":[]}';
 if(listed){requestedName=listed.name;assert.ok(JSON.stringify(body).includes('未揭晓'));if(!containsResults){
 const args={note:'secret itinerary'};
 return res.end(JSON.stringify(format==='openai'?{choices:[{message:{content:null,tool_calls:[{id:'date1',type:'function',function:{name:listed.name,arguments:JSON.stringify(args)}}]}}],usage:{}}:{content:[{type:'thinking',thinking:'secret early thinking'},{type:'tool_use',id:'date1',name:listed.name,input:args}],stop_reason:'tool_use',usage:{}}));
 }sawResult=true;content='<thinking>secret inline thinking</thinking>去 Us 里拆信吧。';}
 res.end(JSON.stringify(format==='openai'?{choices:[{message:{content,reasoning_content:'secret reasoning'}}],usage:{}}:{content:[{type:'thinking',thinking:'secret reasoning'},{type:'text',text:content}],stop_reason:'end_turn',usage:{}}));
 });const providerPort=await listen(provider);const probe=createServer();const port=await listen(probe);await new Promise(r=>probe.close(r));
 const env={...process.env,PORT:String(port),LUMI_DATA_DIR:folder,LUMI_TEST_MODEL_TARGET:`http://127.0.0.1:${providerPort}`,LUMI_TEST_EPHEMERA_TARGET:`http://127.0.0.1:${mcpPort}`,LUMI_MODEL_API_URL:`http://127.0.0.1:${providerPort}/v1`,LUMI_MODEL_API_KEY:'test-only',LUMI_MODEL_NAME:'test-model',LUMI_MEMORY_API_URL:`http://127.0.0.1:${providerPort}`,LUMI_CACHE_KEEPALIVE_ENABLED:'false',LUMI_BACKGROUND_PULSE_MS:'60000'};
 const backend=spawn(process.execPath,['--import',new URL('./mock-ephemera-fetch.js',import.meta.url).pathname,'src/index.js'],{cwd:new URL('..',import.meta.url),env,stdio:'ignore'});const base=`http://127.0.0.1:${port}`;
 try{
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
 const r=await fetch(base+'/v1/chats/default/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'为我写约会',provider:'custom',model:'test-model',customProvider:{apiKey:'test',baseURL:'https://model.test/v1',apiFormat:format}})});const answer=await r.json();assert.equal(r.status,200,JSON.stringify(answer));assert.ok(requestedName);assert.equal(calls,1,JSON.stringify(answer));assert.ok(sawResult);assert.equal(JSON.stringify(answer.assistantMessage).includes('secret'),false);assert.ok(answer.assistantMessage.toolCalls.length);
 const history=await(await fetch(base+'/v1/chats/default/messages')).json();assert.equal(JSON.stringify(history).includes('secret'),false);
 }finally{backend.kill('SIGTERM');await new Promise(r=>backend.once('exit',r));await Promise.all([new Promise(r=>mcp.close(r)),new Promise(r=>provider.close(r))]);await rm(folder,{recursive:true,force:true});}
});
