// Node preload for the native CLI. Changes only the cache request field on
// official Kimi Code K3 model calls. Never forwards credentials elsewhere.
export function withKimiCacheTTL(fetchImpl) {
 return function(input, init) {
  let url;
  try { url=new URL(typeof input==='string'||input instanceof URL?input:input.url); } catch { return fetchImpl(input,init); }
  if(url.protocol==='https:' && ['api.kimi.com','api.kimi.ai'].includes(url.hostname) && typeof init?.body==='string') {
   const path=url.pathname.replace(/\/$/,'');
   if(['/coding/v1/chat/completions','/coding/v1/responses','/coding/v1/messages'].includes(path)) {
    let body;try{body=JSON.parse(init.body);}catch{return fetchImpl(input,init);}
    if(body.model==='k3') {
     if(path.endsWith('/messages'))body.cache_control={type:'ephemeral',ttl:'1h'};
     else body.prompt_cache_options={mode:'implicit',ttl:'1h'};
     return fetchImpl(input,{...init,body:JSON.stringify(body)});
    }
   }
  }
  return fetchImpl(input,init);
 };
}
if(process.env.LUMI_NATIVE_CACHE_TTL==='1h')globalThis.fetch=withKimiCacheTTL(globalThis.fetch.bind(globalThis));
