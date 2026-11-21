import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/acp/client.js';

test('ACP correlates responses and denies unsolicited filesystem requests', async () => {
  const code = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize'){console.log(JSON.stringify({jsonrpc:'2.0',id:99,method:'fs/write_text_file',params:{}}));console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}}))}else if(m.id===99){console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{denied:m.error.code}}))}})`;
  let update; const client=new AcpClient({command:process.execPath,args:['-e',code],env:process.env,onUpdate:(_m,p)=>{update=p;}}).start();
  try { assert.equal((await client.initialize()).protocolVersion,1); await new Promise(r=>setTimeout(r,50)); assert.equal(update.denied,-32601); }
  finally { client.close(); }
});

test('ACP business bridge exposes only allowlisted validated tools', async()=>{
 const {openBusinessMcp}=await import('../src/acp/mcp-bridge.js');let writes=0;
 const bridge=await openBusinessMcp([{name:'memory_write',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}],async()=>{writes++;return {ok:true};});
 const call=async(method,params)=>fetch(bridge.config.url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 try{
  assert.equal((await call('tools/call',{name:'Bash',arguments:{}})).status,400);
  assert.equal((await call('tools/call',{name:'memory_write',arguments:{text:5}})).status,400);
  assert.equal(writes,0);
  assert.equal((await call('tools/call',{name:'memory_write',arguments:{text:'synthetic'}})).status,200);
  assert.equal(writes,1);
 }finally{bridge.close();}
});
