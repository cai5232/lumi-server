'use strict';
const {timingSafeEqual}=require('node:crypto');
const express=require('express');
const {createFerry,createApp}=require('/opt/night-ferry/server/index.js');
const token=process.env.NIGHT_FERRY_TOKEN;
if(!token)throw new Error('NIGHT_FERRY_TOKEN is required');
const ferry=createFerry();
const app=express();
app.get('/health',(_req,res)=>res.json({ok:true}));
app.use((req,res,next)=>{
 const actual=Buffer.from(req.headers.authorization||'');const expected=Buffer.from('Bearer '+token);
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return res.status(401).json({error:'unauthorized'});
 next();
});
app.post('/mcp',express.json({limit:'8mb'}),async(req,res)=>{
 const {id,method,params={}}=req.body||{};
 const reply=result=>res.json({jsonrpc:'2.0',id,result});
 if(id==null)return res.sendStatus(202);
 if(method==='initialize')return reply({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'night-ferry',version:'0.1.0'}});
 if(method==='ping')return reply({});
 if(method==='tools/list')return reply({tools:[{name:ferry.tool.name,description:ferry.tool.description,inputSchema:ferry.tool.input_schema}]});
 if(method==='tools/call'&&params.name===ferry.tool.name){
  try{const out=await ferry.execute(params.arguments||{});return reply({content:[{type:'text',text:JSON.stringify(out.result)},...(out.images||[]).map(b=>({type:'image',data:b.data,mimeType:b.media_type}))],isError:out.result?.ok===false});}
  catch{return reply({content:[{type:'text',text:'夜航船操作失败，记录已保留，请稍后重试。'}],isError:true});}
 }
 return res.json({jsonrpc:'2.0',id,error:{code:-32601,message:'method not found'}});
});
app.use(createApp(ferry));
ferry.resumeImageJobs();
app.listen(3210,'0.0.0.0');
