import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');

test('startup resumes paid checkpoint using its own route without requiring a chat send', async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'lumi-startup-compaction-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const original={id:'default',lastMeasuredInputTokens:600000,messages:[{content:'original history'}]};
 const threads={default:original,other:{id:'other',lastMeasuredInputTokens:600000},small:{id:'small',lastMeasuredInputTokens:1}};
 const path=id=>join(dataDir,'compaction-'+createHash('sha256').update(id).digest('hex').slice(0,24)+'.json');
 await writeFile(path('default'),JSON.stringify({nextIndex:1,summary:'paid first batch'}));
 await writeFile(path('other'),JSON.stringify({nextIndex:1,summary:'another thread'}));
 const calls=[],route={model:'selected-model',customProvider:{url:'https://selected.test',key:'test'}};
 const context={dataDir,join,createHash,readFile,console,compactionPlan:t=>t.lastMeasuredInputTokens>200000?{}:null,
  readThreads:async()=>threads,readMurmurRoutes:async()=>({default:{provider:'custom',customProvider:{data:'encrypted'}}}),
  resolveMurmurRoute:async id=>{assert.equal(id,'default');return route},scheduleBackgroundCompaction:(...args)=>calls.push(args)};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function resumeInterruptedCompactions('),source.indexOf('\nfunction chooseEmojiFromMood(')),context);
 await context.resumeInterruptedCompactions();
 assert.equal(calls.length,1);assert.equal(calls[0][0],'default');assert.equal(calls[0][1],route.model);assert.equal(calls[0][2],route.customProvider);
 assert.equal(original.messages[0].content,'original history');
 await rm(path('default'));
 await context.resumeInterruptedCompactions();
 assert.equal(calls.length,1,'no checkpoint means no unexpected paid generation');
});
