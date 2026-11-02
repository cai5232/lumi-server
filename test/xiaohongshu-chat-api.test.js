import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const listen = async server => {await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port;};
test('Xiaohongshu card persists and sends all images and note content to the model', {timeout:45000}, async () => {
 const directory=await mkdtemp(join(tmpdir(),'lumi-sticker-api-')), seen=[];
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  res.writeHead(200,{'content-type':'application/json'});
  if(req.url.includes('/api/integrations/'))return res.end('{"related":""}');
  if(req.method==='GET')return res.end('[]');
  seen.push(JSON.parse(raw));
  res.end(JSON.stringify({choices:[{message:{content:'测试回复'}}],usage:{prompt_tokens:100,completion_tokens:2}}));
 });
 const providerPort=await listen(provider), probe=createServer();
 const port=20000+Math.floor(Math.random()*10000);await new Promise(r=>probe.listen(port,'127.0.0.1',r));await new Promise(r=>probe.close(r));
 const target=`http://127.0.0.1:${providerPort}`, base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['--import',new URL('./mock-model-fetch.js',import.meta.url).pathname,'src/index.js'],{env:{...process.env,PORT:String(port),LUMI_DATA_DIR:directory,LUMI_PUSH_API_TOKEN:'test',LUMI_MODEL_API_KEY:'test',LUMI_TEST_MODEL_TARGET:target,LUMI_MODEL_API_URL:target+'/v1',LUMI_MEMORY_API_URL:target,LUMI_MODEL_NAME:'test-model',LUMI_CACHE_KEEPALIVE_ENABLED:'false',LUMI_PROMISE_ALARM_ENABLED:'false',DUETTO_INTERNAL_PORT:'0'},stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',chunk=>errors+=chunk);
 const request=(path,data)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test'},body:JSON.stringify(data)});
 try {
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready,'backend started: '+errors);
  const card = { caption: '一起看看', note: { title: '星露谷', author: '作者', desc: '笔记内容', comments: [{user: '读者', content: '评论内容'}], images: Array(5).fill('https://sns-webpic-qc.xhscdn.com/pic'), url: 'https://www.xiaohongshu.com/' }, cover: 'thumbnail' };
  const images = Array(5).fill('data:image/png;base64,iVBORw0KGgo=');
  const response=await request('/v1/chats/default/messages',{content:JSON.stringify(card),contentType:'xiaohongshu',images,provider:'custom',model:'test-model',customProvider:{apiKey:'test',baseURL:'https://model.test/v1',apiFormat:'openai'}});
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();
  assert.equal(result.userMessage.contentType,'xiaohongshu');
  assert.equal(JSON.parse(result.userMessage.content).caption,'一起看看');
  const message=seen.filter(p=>Array.isArray(p.messages)).at(-1)?.messages.filter(m=>m.role==='user').at(-1);
  const modelText=JSON.stringify(message);
  for (const expected of ['一起看看','星露谷','笔记内容','评论内容']) assert.ok(modelText.includes(expected),modelText);
  assert.ok(!modelText.includes('thumbnail'),modelText);
  assert.equal(message.content.filter(block=>block.type==='image_url').length,5);
  const history=await fetch(base+'/v1/chats/default',{headers:{authorization:'Bearer test'}});
  const saved=await history.json();
  assert.equal(saved.messages.find(m=>m.role==='user').contentType,'xiaohongshu');
  assert.equal(saved.messages.find(m=>m.role==='user').imageAttachmentCount,5);
  const followup=await request('/v1/chats/default/messages',{content:'刚才的图呢',provider:'custom',model:'test-model',customProvider:{apiKey:'test',baseURL:'https://model.test/v1',apiFormat:'openai'}});
  assert.equal(followup.status,200,await followup.clone().text());
  const prior=seen.filter(p=>Array.isArray(p.messages)).at(-1)?.messages.find(m=>m.role==='user' && JSON.stringify(m.content).includes('星露谷'));
  assert.equal(prior.content.filter(block=>block.type==='image_url').length,5);

 } finally {
  if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
  await new Promise(r=>provider.close(r));await rm(directory,{recursive:true,force:true});
 }
});
