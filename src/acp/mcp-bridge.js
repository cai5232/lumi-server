import {z} from 'zod';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
export async function openBusinessMcp(tools, execute) {
 const token=randomUUID(); const server=createServer(async(req,res)=>{
  if(req.url!=='/'+token){res.writeHead(404);res.end();return;}
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  try {
   let raw='';for await(const b of req){raw+=b;if(raw.length>2000000)throw new Error('Request too large');}
   const m=JSON.parse(raw);if(m.id===undefined){res.writeHead(202);res.end();return;}
   let result;
   if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'lumi',version:'1'}};
   else if(m.method==='tools/list')result={tools:tools.map(t=>({name:t.name,description:t.description,inputSchema:t.input_schema}))};
   else if(m.method==='tools/call'){
    if(!tools.some(t=>t.name===m.params?.name))throw new Error('Tool unavailable');
    result={content:[{type:'text',text:JSON.stringify(await execute(m.params.name,z.fromJSONSchema(tools.find(t=>t.name===m.params.name).input_schema).parse(m.params.arguments||{})))}]};
   }else throw new Error('Method unavailable');
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  }catch{res.writeHead(400);res.end(JSON.stringify({error:'Invalid MCP request'}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {config:{type:'http',name:'lumi',url:`http://127.0.0.1:${server.address().port}/${token}`,headers:[]},close:()=>{server.closeAllConnections();server.close();}};
}
