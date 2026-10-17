import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {relayEndpoint,requestRelay} from '../src/relay-transport.js';
import {responseThinking} from '../src/response-thinking.js';
const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
const start=source.indexOf('async function callModel('),end=source.indexOf('\nasync function zenMuxSubscriptionUsage',start);
for(const format of ['openai','anthropic'])test(`real callModel ${format} route keeps chosen endpoint, auth, usage and thinking without connecting unavailable MCP`,async()=>{
 let captured,usage;
 const context={URL,Date,Math,Map,JSON,Number,String,Array,Boolean,console,process:{env:{}},relayEndpoint,responseThinking,
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
 assert.equal(content,'<thinking>实际返回的心声</thinking>\n你好');assert.ok(usage);assert.equal(captured.headers.authorization,'Bearer test-key');
 assert.equal(captured.url,format==='anthropic'?'https://custom.test/v1/messages':'https://custom.test/v1/chat/completions');
 if(format==='anthropic'){assert.equal(captured.headers['x-api-key'],'test-key');assert.equal(captured.body.messages[0].role,'user');assert.equal(captured.body.system[0].text,'设定')}
 else assert.equal(captured.body.messages[0].role,'system');
});
test('public messages exclude persisted context while retaining actual saved thinking',()=>{
 const start=source.indexOf('function publicChatMessage('),end=source.indexOf('\nfunction stripInternalContextMarkup',start);
 const context={extractThinkingText:()=> '保存的心声'};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 const result=context.publicChatMessage({id:'1',role:'assistant',content:'正文',modelContent:'private context',requestId:'retry-key'});
 assert.equal(result.content,'正文');assert.equal(result.thinking,'保存的心声');assert.ok(!('modelContent'in result));assert.ok(!('requestId'in result));
});
