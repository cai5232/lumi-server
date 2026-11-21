import {parse,stringify} from 'smol-toml';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
export function createAcpAuth(runtime){
 let child,status={state:'not_authorized'};
 const marker=join(runtime.home,'lumi-authorized.json');
 return {
  async status(){if(status.state==='not_authorized')try{await access(marker);return {state:'authorized'};}catch{}return status;},
  async begin(){
   if(child)return status;
   await mkdir(runtime.home,{recursive:true});status={state:'starting'};
   child=spawn(process.execPath,[runtime.cli,'login'],{env:runtime.env,stdio:['ignore','pipe','pipe']});
   const consume=b=>{const text=String(b).replace(/\x1b\[[0-9;]*m/g,'');const url=text.match(/https:\/\/[^\s\x1b]+/);const code=text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);if(url&&/^https:\/\/(?:[a-z0-9-]+\.)*kimi\.(?:com|ai)\//.test(url[0]))status={...status,state:'authorization_required',url:url[0]};if(code)status={...status,code:code[0]};};
   child.stdout.on('data',consume);child.stderr.on('data',consume);
   child.once('error',()=>{child=null;status={state:'error',error:'Kimi 登录进程无法启动'};});
   child.once('exit',async code=>{try{child=null;if(code===0){const path=join(runtime.home,'config.toml');const cfg=parse(await readFile(path,'utf8'));if(!cfg.providers?.['managed:kimi-code']){status={state:'error',error:'需要 Kimi Code 原生账号登录'};return;}const native=cfg.models?.['kimi-code/k3'];if(!native||native.model!=='k3')throw new Error('Native K3 metadata unavailable');cfg.models={...cfg.models,'lumi-k3':{...native,max_context_size:200000}};cfg.default_model='lumi-k3';cfg.loop_control={...cfg.loop_control,reserved_context_size:12000,compaction_trigger_ratio:0.99};await writeFile(path,stringify(cfg),{mode:0o600});await writeFile(marker,JSON.stringify({at:new Date().toISOString()}),{mode:0o600});status={state:'authorized'};}else status={state:'error',error:'登录尚未完成或已过期，请重试'};}catch{status={state:'error',error:'登录配置保存失败，请重试'};}});
   return status;
  }
 };
}
