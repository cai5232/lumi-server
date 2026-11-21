import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AcpClient} from './client.js';
import {openBusinessMcp} from './mcp-bridge.js';
import {createHarnessState,fingerprint} from '../harness-state.js';
import {reconstructInput,messageBlocks} from '../harness-runtime.js';
const cli=fileURLToPath(new URL('../../node_modules/@moonshot-ai/kimi-code/dist/main.mjs',import.meta.url));
export function createAcpRuntime(config){
 const root=resolve(config.root,'../kimi-acp');const state=createHarnessState(join(root,'sessions'));
 const diagnostics=new Map();
 const env={PATH:process.env.PATH,HOME:root,KIMI_CODE_HOME:join(root,'home'),LANG:process.env.LANG||'en_US.UTF-8'};
 return {
  home:env.KIMI_CODE_HOME,cli,env,
  diagnostic:id=>diagnostics.get(id)||null,
  async finalize(receipt,hash){if(!receipt)return;const release=await state.lock(receipt.key);try{const s=await state.read(receipt.key);if(s?.runId===receipt.runId)await state.write(receipt.key,{...s,status:'ready',expectedHistoryHash:hash});}finally{await release();}},
  async run({threadId,scope='chat',messages,persona,tools=[],executeTool,historyHash,ephemeral=false,signal,onUsage=()=>{}}){
   const key=`${threadId}:${scope}`;const release=await state.lock(key);let client,bridge;const runId=crypto.randomUUID();
   try{
    const system=messages.filter(m=>['system','developer'].includes(m.role)).map(m=>m.content).join('\n\n');
    const definition=fingerprint({system,tools,model:config.model});const old=ephemeral?null:await state.read(key);
    const resume=old?.status==='ready'&&old.definition===definition&&old.expectedHistoryHash===historyHash;
    const cwd=join(root,'workspaces',fingerprint(key));await mkdir(join(cwd,'.git'),{recursive:true});await mkdir(join(cwd,'.kimi-code','agents'),{recursive:true});await mkdir(env.KIMI_CODE_HOME,{recursive:true});
    const agent=join(cwd,'.kimi-code','agents','agent.md');await writeFile(agent,'---\nname: agent\noverride: true\ndescription: Lumi companion\ntools:\n  - mcp__lumi__*\nsubagents: []\n---\n'+system,{mode:0o600});
    bridge=await openBusinessMcp(tools,executeTool);let text='',thinking='',usage={};
    client=new AcpClient({command:process.execPath,args:[cli,'acp'],env,onRequest:async(method,p)=>{
     if(method !== 'session/request_permission')return;
     const title=p.toolCall?.title;
     const allowed=tools.some(t=>title===t.name||title===`mcp__lumi__${t.name}`);
     const option=allowed&&p.options?.find(o=>o.kind==='allow_once');
     return {outcome:option?{outcome:'selected',optionId:option.optionId}:{outcome:'cancelled'}};
    },onUpdate:(method,p)=>{
     if(method!=='session/update')return;const u=p.update||{};
     if(u.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text')text+=u.content.text;
     if(u.sessionUpdate==='agent_thought_chunk'&&u.content?.type==='text')thinking+=u.content.text;
     if(u.sessionUpdate==='usage_update')usage=u;
    }}).start();
    await client.initialize();let session;
    if(resume){await client.request('session/load',{sessionId:old.sessionId,cwd,mcpServers:[bridge.config]});session=old.sessionId;text='';thinking='';}
    else session=(await client.request('session/new',{cwd,mcpServers:[bridge.config]})).sessionId;
    await client.request('session/set_model',{sessionId:session,modelId:'lumi-k3'});
    const blocks=(resume?messageBlocks(messages.at(-1)):reconstructInput(messages)).map(b=>b.type==='image'?{type:'image',mimeType:b.source.media_type,data:b.source.data}:b);
    const abort=()=>{client.request('session/cancel',{sessionId:session}).catch(()=>{});client.close();};signal?.addEventListener('abort',abort,{once:true});
    try{if(signal?.aborted)throw new Error('Cancelled');const result=await client.request('session/prompt',{sessionId:session,prompt:blocks},600000);if(result.stopReason!=='end_turn'||!text.trim())throw new Error('ACP response incomplete');}finally{signal?.removeEventListener('abort',abort);}
    const diagnostic={runtime:'kimi-acp',mode:resume?'resume':'new',sessionId:session,model:config.model,at:new Date().toISOString(),calls:1,usage,cacheTTL:'native_provider_managed'};diagnostics.set(threadId,diagnostic);onUsage(usage);
    if(!ephemeral)await state.write(key,{status:'generated',runId,sessionId:session,definition});
    return {content:text.trim(),thinking,usage,lastUsage:usage,diagnostic,receipt:ephemeral?null:{runtime:'kimi-acp',key,runId},finishReason:'end_turn'};
   }catch(e){if(!ephemeral)await state.write(key,{status:'invalid',runId});throw Object.assign(new Error('Kimi ACP: '+e.message),{statusCode:503});}
   finally{client?.close();bridge?.close();await release();}
  }
 };
}
