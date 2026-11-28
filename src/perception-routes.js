import { MAX_MEDIA_BYTES } from './multimodal-perception.js';

export function createPerceptionRoutes(store, {authorized,send,readJSON,readBinary}) {
  return async (req,res,url) => {
    if (!url.pathname.startsWith('/v1/perception/')) return false;
    if (!authorized(req)) {send(res,401,{error:'unauthorized'});return true;}
    try {
      const p=url.pathname;
      if(p==='/v1/perception/settings'&&req.method==='GET')send(res,200,await store.settings());
      else if(p==='/v1/perception/settings'&&req.method==='PUT')send(res,200,await store.save(await readJSON(req,16000)));
      else if(p==='/v1/perception/test'&&req.method==='POST')send(res,200,await store.testConnection());
      else if(p==='/v1/perception/usage'&&req.method==='GET')send(res,200,{requests:await store.usage()});
      else if(p==='/v1/perception/files'&&req.method==='POST') {
        const mimeType=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
        const name=decodeURIComponent(String(req.headers['x-file-name']||'附件'));
        send(res,202,await store.upload(await readBinary(req,MAX_MEDIA_BYTES),mimeType,name));
      } else {
        const match=p.match(/^\/v1\/perception\/files\/([a-f0-9]{64})(\/(?:content|retry))?$/);
        if(!match)send(res,404,{error:'not_found'});
        else if(req.method==='GET'&&!match[2])send(res,200,await store.get(match[1]));
        else if(req.method==='POST'&&match[2]==='/retry')send(res,202,await store.retry(match[1]));
        else if(req.method==='GET'&&match[2]==='/content') {
          const {item,bytes}=await store.file(match[1]);
          let start=0,end=bytes.length-1,status=200;
          if(req.headers.range) {
            const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if(!range||(!range[1]&&!range[2])) {res.writeHead(416,{'content-range':`bytes */${bytes.length}`});res.end();return true;}
            if(!range[1])start=Math.max(0,bytes.length-Number(range[2]));
            else {start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));}
            if(start>end||start>=bytes.length){res.writeHead(416,{'content-range':`bytes */${bytes.length}`});res.end();return true;}
            status=206;
          }
          res.writeHead(status,{'content-type':item.mimeType,'content-length':end-start+1,'cache-control':'private, max-age=86400','accept-ranges':'bytes','x-content-type-options':'nosniff',...(status===206?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})});res.end(bytes.subarray(start,end+1));
        } else send(res,405,{error:'method_not_allowed'});
      }
    } catch(error){send(res,error.statusCode||500,{error:error.message==='calendar_page_too_large'?'原始文件超过 12 MiB，请选取较短片段。':error.statusCode?error.message:'感知模块暂时不可用，请稍后重试。'});}
    return true;
  };
}
