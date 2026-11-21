import test from 'node:test';
import assert from 'node:assert/strict';
import {withKimiCacheTTL} from '../src/acp/cache-ttl-fetch.js';
test('native TTL adapter confines changes to official Code K3 model requests',async()=>{
 const seen=[];const f=withKimiCacheTTL(async(u,o)=>{seen.push({u,o});return 'ok';});
 const body={model:'k3',messages:[{role:'user',content:'fixture'}],tools:[{name:'memory_search'}]};
 await f('https://api.kimi.com/coding/v1/chat/completions',{method:'POST',headers:{'x-api-key':'synthetic'},body:JSON.stringify(body)});
 const actual=JSON.parse(seen[0].o.body);assert.deepEqual(actual,{...body,prompt_cache_options:{mode:'implicit',ttl:'1h'}});assert.deepEqual(seen[0].o.headers,{'x-api-key':'synthetic'});
 await f('https://api.kimi.com/coding/v1/messages',{body:JSON.stringify(body)});assert.deepEqual(JSON.parse(seen[1].o.body).cache_control,{type:'ephemeral',ttl:'1h'});
 for(const [url,model] of [['https://auth.kimi.com/oauth/token','k3'],['https://api.moonshot.cn/v1/chat/completions','k3'],['https://other.test/coding/v1/messages','k3'],['https://api.kimi.com/coding/v1/messages','other']]){
  const init={body:JSON.stringify({...body,model})};await f(url,init);assert.equal(seen.at(-1).o,init);
 }
});
