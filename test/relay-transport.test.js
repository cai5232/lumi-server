import {test} from 'node:test';
import assert from 'node:assert/strict';
import {relayEndpoint,decodeRelayResponse,requestRelay} from '../src/relay-transport.js';
test('relay URLs accept roots, version prefixes and complete endpoints without duplication',()=>{
 for(const [base,path,expected] of [
  ['https://relay.test','/chat/completions','https://relay.test/v1/chat/completions'],
  ['https://relay.test/v1/','/chat/completions','https://relay.test/v1/chat/completions'],
  ['https://relay.test/v1/chat/completions','/chat/completions','https://relay.test/v1/chat/completions'],
  ['https://relay.test/api/v1','/v1/messages','https://relay.test/api/v1/messages'],
  ['https://relay.test/v1/messages','/messages','https://relay.test/v1/messages'],
  ['https://relay.test/v1/messages','/models','https://relay.test/v1/models'],
  ['https://relay.test/compatible-mode/v1','/chat/completions','https://relay.test/compatible-mode/v1/chat/completions']
 ])assert.equal(relayEndpoint(base,path),expected);
});
test('a rejected optional field is adapted once and remembered; credentials and protocol stay fixed',async()=>{
 const attempts=[];
 const fake=async(url,options)=>{const body=JSON.parse(options.body);attempts.push({url,options,body});return body.tools?new Response(JSON.stringify({error:{message:'tools are not supported by this model'}}),{status:400}):new Response(JSON.stringify({choices:[{message:{content:'成功'}}]}));};
 const options={url:'https://relay.test/v1/chat/completions',headers:{authorization:'Bearer test-only'},body:{model:'no-tools-model',messages:[{role:'user',content:'你好'}],tools:[{type:'function'}],tool_choice:'auto'},fetchImpl:fake};
 const result=await requestRelay(options);assert.equal(result.data.choices[0].message.content,'成功');assert.equal(attempts.length,2);
 await requestRelay(options);assert.equal(attempts.length,3);
 assert.ok(options.body.tools,'original body is not mutated');
 for(const attempt of attempts){assert.equal(attempt.url,options.url);assert.equal(attempt.options.headers.authorization,'Bearer test-only');assert.equal(attempt.body.model,'no-tools-model');}
});
test('authentication, quota, context-limit, and service errors are never replayed as compatibility retries',async()=>{
 for(const [status,message] of [[401,'Invalid API key'],[429,'quota exhausted'],[400,'context length exceeded'],[502,'upstream unavailable']]){
  let calls=0;
  const result=await requestRelay({url:'https://relay.test/v1/messages',headers:{},body:{model:'error-model',tools:[]},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({error:{message}}),{status})}});
  assert.equal(result.response.status,status);assert.equal(calls,1);
 }
});
test('cache TTL and temperature compatibility does not discard text or cache markers',async()=>{
 let calls=0;
 const result=await requestRelay({url:'https://ttl.test/v1/messages',headers:{},body:{model:'claude',system:[{type:'text',text:'原始设定',cache_control:{type:'ephemeral',ttl:'1h'}}],temperature:0.8,messages:[{role:'user',content:'完整原句'}]},fetchImpl:async(_,options)=>{
  calls++;const b=JSON.parse(options.body);assert.equal(b.messages[0].content,'完整原句');assert.equal(b.system[0].text,'原始设定');
  if(b.system[0].cache_control.ttl)return new Response(JSON.stringify({error:{message:'ttl is not supported'}}),{status:400});
  if('temperature'in b)return new Response(JSON.stringify({error:{message:'temperature is not allowed'}}),{status:422});
  assert.equal(b.system[0].cache_control.type,'ephemeral');return new Response('{"content":[{"type":"text","text":"好"}]}');
 }});assert.equal(calls,3);assert.equal(result.data.content[0].text,'好');
});
test('compatible event streams keep response text, tool arguments and actual reasoning',()=>{
 const lines=[{choices:[{delta:{content:'你',reasoning_content:'考虑'}}]},{choices:[{delta:{content:'好',tool_calls:[{index:0,id:'a',function:{name:'lookup',arguments:'{"q":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"x"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:42,completion_tokens:3}}];
 const result=decodeRelayResponse(lines.map(x=>'data: '+JSON.stringify(x)).join('\n\n')+'\n\ndata: [DONE]');
 assert.equal(result.choices[0].message.content,'你好');assert.equal(result.choices[0].message.reasoning_content,'考虑');assert.equal(result.choices[0].message.tool_calls[0].function.arguments,'{"q":"x"}');assert.equal(result.usage.prompt_tokens,42);
 const native=decodeRelayResponse('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"原生字幕"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}');
 assert.equal(native.content[0].text,'原生字幕');assert.equal(native.usage.output_tokens,4);
});
test('explicit output limits adapt to the upstream maximum without limiting smaller tasks',async()=>{
 let calls=0;
 const fake=async(_,request)=>{calls++;const body=JSON.parse(request.body);return body.max_tokens>64000?new Response('{"error":{"message":"max_tokens: 128000 > 64000"}}',{status:400}):new Response(JSON.stringify({content:[{type:'text',text:String(body.max_tokens)}]}))};
 const base={url:'https://limited.test/v1/messages',headers:{},fetchImpl:fake};
 const long=await requestRelay({...base,body:{model:'limited-claude',max_tokens:128000}});assert.equal(long.requestBody.max_tokens,64000);assert.equal(calls,2);
 const short=await requestRelay({...base,body:{model:'limited-claude',max_tokens:96}});assert.equal(short.requestBody.max_tokens,96);assert.equal(calls,3);
});
test('network failures and timeouts carry gateway status instead of internal-server status',async()=>{
 await assert.rejects(requestRelay({url:'https://unreachable.test/v1/messages',headers:{},body:{model:'test'},fetchImpl:async()=>{throw new Error('network down')}}),error=>error.statusCode===502);
 await assert.rejects(requestRelay({url:'https://timeout.test/v1/messages',headers:{},body:{model:'test'},timeoutMS:10,fetchImpl:async(_,options)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(resolve,1000);
  options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'))},{once:true});
 })}),error=>error.statusCode===504&&error.message.includes('1 秒'));
});
test('explicit stream rejection retries once as JSON without changing model, messages or auth',async()=>{
 const attempts=[];
 const result=await requestRelay({url:'https://json-only.test/v1/messages',headers:{authorization:'Bearer fake'},body:{model:'json-only',stream:true,messages:[{role:'user',content:'完整原文'}]},fetchImpl:async(_,request)=>{
  const body=JSON.parse(request.body);attempts.push(body);assert.equal(request.headers.authorization,'Bearer fake');
  return body.stream?new Response('{"error":{"message":"stream is not supported"}}',{status:400}):new Response('{"content":[{"type":"text","text":"OK"}]}');
 }});
 assert.equal(attempts.length,2);assert.equal(result.data.content[0].text,'OK');
 assert.equal(attempts[1].model,'json-only');assert.deepEqual(attempts[1].messages,attempts[0].messages);
});
const sse=(chunks,{gapMS=0,close=true}={})=>new Response(new ReadableStream({async start(c){for(const s of chunks){if(gapMS)await new Promise(r=>setTimeout(r,gapMS));c.enqueue(new TextEncoder().encode(s));}if(close)c.close();}}));
test('a slow but live stream is not cut by the idle timeout even when its total time exceeds it',async()=>{
 const chunks=['你','好','呀','，','在','的'].map(t=>'data: '+JSON.stringify({choices:[{delta:{content:t}}]})+'\n\n');
 const result=await requestRelay({url:'https://slow.test/v1/chat/completions',headers:{},body:{model:'slow',stream:true},timeoutMS:60,fetchImpl:async()=>sse(chunks,{gapMS:30})});
 assert.equal(result.data.choices[0].message.content,'你好呀，在的');assert.ok(result.timing.totalMs>=60);assert.equal(result.timing.endedBy,'close');
});
test('a finished stream whose connection never closes ends at the protocol marker',async()=>{
 const openai=await requestRelay({url:'https://open.test/v1/chat/completions',headers:{},body:{model:'open'},timeoutMS:500,fetchImpl:async()=>sse(['data: {"choices":[{"delta":{"content":"完"}}]}\n\n','data: [DONE]\n\n'],{close:false})});
 assert.equal(openai.data.choices[0].message.content,'完');assert.equal(openai.timing.endedBy,'marker');
 const native=await requestRelay({url:'https://open.test/v1/messages',headers:{},body:{model:'open'},timeoutMS:500,fetchImpl:async()=>sse(['event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n','event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n','event: message_stop\ndata: {"type":"message_stop"}\n\n'],{close:false})});
 assert.equal(native.data.content[0].text,'好');assert.equal(native.timing.endedBy,'marker');
});
test('a stream that stalls midway fails as a gateway timeout and reports how far it got',async()=>{
 await assert.rejects(requestRelay({url:'https://stall.test/v1/chat/completions',headers:{},body:{model:'stall'},timeoutMS:50,fetchImpl:async(_,options)=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半"}}]}\n\n'));options.signal.addEventListener('abort',()=>c.error(new Error('aborted')),{once:true});}}))}),
  error=>error.statusCode===504&&error.timing.bytes>0&&error.timing.firstChunkMs!==null&&error.message.includes('字节后中断'));
});
test('the hard cap still ends a stream that keeps trickling forever',async()=>{
 await assert.rejects(requestRelay({url:'https://drip.test/v1/chat/completions',headers:{},body:{model:'drip'},timeoutMS:200,maxMS:80,fetchImpl:async(_,options)=>new Response(new ReadableStream({start(c){const t=setInterval(()=>c.enqueue(new TextEncoder().encode(': ping\n\n')),10);options.signal.addEventListener('abort',()=>{clearInterval(t);c.error(new Error('aborted'))},{once:true});}}))}),
  error=>error.statusCode===504&&error.message.includes('总耗时'));
});
