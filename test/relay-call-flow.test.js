import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {relayEndpoint,requestRelay} from '../src/relay-transport.js';
import {removeMalformedAnthropicThinkingBlocks} from '../src/anthropic-messages.js';
import {assertChatContextBudget} from '../src/context-budget.js';
import {responseThinking} from '../src/response-thinking.js';
const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
const start=source.indexOf('async function callModel('),end=source.indexOf('\nasync function zenMuxSubscriptionUsage',start);
for(const format of ['openai','anthropic'])test(`real callModel ${format} route keeps chosen endpoint, auth, usage and thinking without connecting unavailable MCP`,async()=>{
 let captured,usage;
 const context={URL,Date,Math,Map,JSON,Number,String,Array,Boolean,console,process:{env:{}},relayEndpoint,responseThinking,removeMalformedAnthropicThinkingBlocks,assertChatContextBudget,contextLimitTokens:200000,
  mcpClientStore:{read:async()=>({servers:[{enabled:true,tools:[],name:'offline'}]})},modelToolsForServer:()=>[],
  connectPendingMcpServers:()=>{throw new Error('chat must not wait for MCP discovery')},calendarTools:[],foodTools:[],ENGAWA_SERVER_ID:'engawa',
  cacheMessages:messages=>messages,cacheDiagnosticCapture:()=>null,recordModelRequest:async()=>{},randomUUID:()=> 'test-id',modelRequestLogJSON:JSON.stringify,
  cacheUsage:()=>({read:0,created:0}),cacheStats:{modelCalls:0,cacheReadTokens:0,cacheWriteTokens:0},saveCacheStats:async()=>{},
  requestRelay:options=>requestRelay({...options,fetchImpl:async(url,request)=>{
   captured={url,headers:request.headers,body:JSON.parse(request.body)};
   return new Response(JSON.stringify(format==='anthropic'?{content:[{type:'thinking',thinking:'实际返回的心声'},{type:'text',text:'你好'}],usage:{input_tokens:12,output_tokens:2}}:{choices:[{message:{content:'你好',reasoning_content:'实际返回的心声'}}],usage:{prompt_tokens:12,completion_tokens:2}}));
  }})};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 const content=await context.callModel({provider:'custom',model:'claude-test',customProvider:{url:format==='anthropic'?'https://custom.test/v1/messages':'https://custom.test/v1/chat/completions',key:'test-key',apiFormat:format,chatPath:format==='anthropic'?'/messages':'/chat/completions'},messages:[{role:'system',content:'设定'},{role:'user',content:'你好'}],mcpThreadId:'default',onUsage:value=>{usage=value}});
 assert.equal(content,'<thinking>实际返回的心声</thinking>\n你好');assert.ok(usage);assert.equal(captured.headers.authorization,'Bearer test-key');assert.equal(captured.headers.accept,'text/event-stream');assert.equal(captured.body.stream,true);
 assert.equal(captured.url,format==='anthropic'?'https://custom.test/v1/messages':'https://custom.test/v1/chat/completions');
 if(format==='anthropic'){assert.equal(captured.headers['x-api-key'],'test-key');assert.equal(captured.body.messages[0].role,'user');assert.equal(captured.body.system[0].text,'设定')}
 else assert.equal(captured.body.messages[0].role,'system');
 if(format==='anthropic') {
  await context.callModel({provider:'custom',model:'claude-test',customProvider:{url:'https://custom.test/v1',key:'test-key',apiFormat:'anthropic'},messages:[{role:'user',content:'summarize'}],disableThinkingRetry:true,returnMetadata:true});
  assert.equal(captured.body.thinking.type,'disabled','summary requests must explicitly disable default provider thinking');
 }

});
test('public messages exclude persisted context while retaining actual saved thinking',()=>{
 const start=source.indexOf('function publicChatMessage('),end=source.indexOf('\nfunction stripInternalContextMarkup',start);
 const context={extractThinkingText:()=> '保存的心声'};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 const result=context.publicChatMessage({id:'1',role:'assistant',content:'正文',modelContent:'private context',requestId:'retry-key'});
 assert.equal(result.content,'正文');assert.equal(result.thinking,'保存的心声');assert.ok(!('modelContent'in result));assert.ok(!('requestId'in result));
});
test('real callModel identifies disabled upstream credentials and preserves upstream service status',async()=>{
 for(const [status,message,expected] of [[503,'auth_unavailable: no auth available; service has been disabled',503],[429,'quota exhausted',429],[502,'upstream unavailable',502],[401,'invalid provider key',502]]){
  const context={URL,Date,Math,Map,JSON,Number,String,Array,Boolean,Error,console,process:{env:{}},relayEndpoint,
   mcpClientStore:{read:async()=>({servers:[]})},calendarTools:[],foodTools:[],ENGAWA_SERVER_ID:'engawa',
   cacheMessages:messages=>messages,cacheDiagnosticCapture:()=>null,recordModelRequest:async()=>{},randomUUID:()=> 'test-id',modelRequestLogJSON:JSON.stringify,
   cacheUsage:()=>({read:0,created:0}),requestRelay:async options=>({response:new Response('{}',{status}),data:{error:{message}},requestBody:options.body})};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  await assert.rejects(context.callModel({provider:'custom',model:'chosen-model',customProvider:{url:'https://relay.test/v1',key:'test-key',apiFormat:'openai'},messages:[{role:'user',content:'test'}]}),error=>{
   assert.equal(error.statusCode,expected);
   if(status===503){assert.ok(error.message.includes('chosen-model'));assert.ok(error.message.includes('上游渠道不可用'));}
   return true;
  });
 }
});

for (const format of ['openai', 'anthropic']) test(`oversized ${format} chat is blocked before contacting the relay`, async () => {
 let calls = 0;
 const context = { URL, console, process: { env: {} }, relayEndpoint, removeMalformedAnthropicThinkingBlocks,
  mcpClientStore: { read: async () => ({ servers: [] }) }, calendarTools: [], foodTools: [], ENGAWA_SERVER_ID: 'engawa',
  cacheMessages: messages => messages, assertChatContextBudget, contextLimitTokens: 200000,
  requestRelay: async () => { calls++; throw Error('must not reach upstream'); } };
 vm.createContext(context); vm.runInContext(source.slice(start, end), context);
 for (const knownInputTokens of [0, 600000]) {
  await assert.rejects(context.callModel({ provider: 'custom', model: 'chosen',
   customProvider: {url:'https://relay.test/v1',key:'test',apiFormat:format}, mcpThreadId: 'default',
   knownInputTokens, messages: [{role:'user',content: knownInputTokens ? 'small local estimate' : '大'.repeat(200001)}] }),
   error => error.code === 'context_compaction_required' && error.statusCode === 503);
 }
 assert.equal(calls, 0);
});
