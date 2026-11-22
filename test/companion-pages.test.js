import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createCompanionPages} from '../src/companion-pages.js';
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(status,headers={}){this.status=status;Object.assign(this.headers,headers);},end(body=''){this.body=String(body);}};}
async function request(proxy,path,{method='GET',cookie,authorization,origin,body=''}={}){
 const req=Readable.from(body?[Buffer.from(body)]:[]);Object.assign(req,{method,headers:{cookie,authorization,origin,...(body?{'content-type':'application/json'}:{})}});
 const res=response();await proxy(req,res,new URL(path,'https://lumi.test'));return res;
}
test('companion page sessions isolate services, expire, reject cross-origin writes, and never expose service tokens',async()=>{
 let time=1000;const seen=[];
 const proxy=createCompanionPages({authorized:req=>req.headers.authorization==='Bearer app-test',env:{LUMI_PUBLIC_BASE_URL:'https://lumi.test',LUMI_KITCHENETTE_MCP_TOKEN:'private-kitchen',LUMI_NIGHT_FERRY_MCP_TOKEN:'private-ferry'},now:()=>time,fetchImpl:async(url,options)=>{seen.push({url:String(url),options});return new Response('<html><head></head><script src="/page/app.js"></script></html>',{headers:{'content-type':'text/html'}});}});
 const path='/v1/companions/kitchenette/';
 assert.equal((await request(proxy,path+'page/')).status,401);
 assert.equal((await request(proxy,path+'session',{method:'POST'})).status,401);
 const session=await request(proxy,path+'session',{method:'POST',authorization:'Bearer app-test'});
 assert.equal(session.status,200);assert.match(session.headers['set-cookie'],/HttpOnly; Secure; SameSite=Strict/);
 const cookie=session.headers['set-cookie'].split(';')[0];
 const page=await request(proxy,path+'page/',{cookie});assert.equal(page.status,200);
 assert.ok(page.body.includes('src="'+path+'page/app.js"'));assert.ok(page.body.includes('window.fetch'));
 assert.ok(!page.body.includes('private-kitchen'));assert.equal(seen[0].options.headers.authorization,'Bearer private-kitchen');
 assert.equal((await request(proxy,'/v1/companions/night-ferry/',{cookie})).status,401);
 assert.equal((await request(proxy,path+'api/fridge/buy',{method:'POST',cookie,origin:'https://evil.test',body:'{}'})).status,403);
 const own=await request(proxy,path+'api/about',{cookie,origin:'https://lumi.test'});assert.equal(own.status,200);
 assert.equal((await request(proxy,path+'mcp',{cookie})).status,404);
 assert.equal((await request(proxy,'/v1/companions/unknown/',{cookie})).status,404);
 time+=2*60*60_000;assert.equal((await request(proxy,path+'page/',{cookie})).status,401);
});
