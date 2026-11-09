import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpClientStore,modelToolsForServer,normalizeMcpServers,mcpRequest} from '../src/mcp-clients.js';
test('configured memory MCP uses private credentials only at request time and preserves other servers',async()=>{
 const previous={url:process.env.LUMI_MEMORY_API_URL,key:process.env.LUMI_MEMORY_API_KEY};
 process.env.LUMI_MEMORY_API_URL='http://memory-private:8000';process.env.LUMI_MEMORY_API_KEY='test-secret';
 const folder=await mkdtemp(join(tmpdir(),'lumi-memory-mcp-'));const originalFetch=globalThis.fetch;
 try{
  const store=new McpClientStore(join(folder,'mcp.json'));
  let settings=await store.read();let memory=settings.servers.find(s=>s.id==='nocturne-memory');
  assert.equal(memory.url,'http://memory-private:8000/mcp');assert.deepEqual(memory.headers,{});
  assert.throws(()=>normalizeMcpServers([{...memory,url:'http://127.0.0.1:1/mcp'}]),/HTTPS/);
  const other={id:'other',name:'Other',url:'https://example.com/mcp',enabled:true};
  await store.save({servers:[...settings.servers,other]});
  assert.equal((await store.read()).servers.some(s=>s.id==='other'),true);
  assert.equal((await readFile(join(folder,'mcp.json'),'utf8')).includes('test-secret'),false);
  globalThis.fetch=async(url,options)=>{assert.equal(url,memory.url);assert.equal(options.headers.authorization,'Bearer test-secret');return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{tools:[]}}),{headers:{'content-type':'application/json'}});};
  await mcpRequest(memory,'tools/list');
  assert.deepEqual(modelToolsForServer({...memory,tools:['hold','trace','breath','wander','drive','trail_family'].map(name=>({name}))}).map(t=>t.name),['hold','trace','breath','wander']);
 }finally{globalThis.fetch=originalFetch;await rm(folder,{recursive:true,force:true});for(const [name,value] of [['LUMI_MEMORY_API_URL',previous.url],['LUMI_MEMORY_API_KEY',previous.key]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});
