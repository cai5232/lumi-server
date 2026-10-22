import {cacheInputTokens} from './usage-activity.js';
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
// Keep full requests separately so each chat no longer rereads and rewrites every historical prompt.
export function createModelRequestStore(directory) {
  const legacyPath = join(directory, 'model-request-logs.json');
  const indexPath = join(directory, 'model-request-index.json');
  const detailDirectory = join(directory, 'model-request-details');
  let entries, loading, queue = Promise.resolve();
  const recent = new Map();
  const detailPath = id => join(detailDirectory, createHash('sha256').update(String(id)).digest('hex') + '.json');
  const metadata = ({requestJSON,responseJSON,...record}) => {
    const normalized = cacheInputTokens({...record,responseJSON});
    return {...record, ...(normalized === null ? {} : {cacheInputTokens: normalized})};
  };
  async function load() {
    if (entries) return;
    if (!loading) loading = (async()=>{
      try { entries = JSON.parse(await readFile(indexPath,'utf8')).requests || []; }
      catch(error) {
        if(error.code !== 'ENOENT') throw error;
        try {
          const legacy = JSON.parse(await readFile(legacyPath,'utf8')).requests || [];
          entries = legacy.map(metadata);
          for(const item of legacy.slice(-20)) recent.set(item.id,item);
        } catch(error) { if(error.code !== 'ENOENT') throw error; entries=[]; }
      }
    })();
    await loading;
  }
  return {
    append(record) {
      queue = queue.catch(()=>{}).then(async()=>{
        await load(); await mkdir(detailDirectory,{recursive:true});
        const detail = detailPath(record.id), temporaryDetail = detail+'.'+randomUUID()+'.tmp';
        await writeFile(temporaryDetail,JSON.stringify(record),{mode:0o600}); await rename(temporaryDetail,detail);
        const cutoff = Date.now()-100*24*60*60*1000;
        const next=[...entries, {...metadata(record), detailStored:true}].filter(item=>Date.parse(item.createdAt)>=cutoff).slice(-20000);
        const temporaryIndex=indexPath+'.'+randomUUID()+'.tmp';
        await writeFile(temporaryIndex,JSON.stringify({requests:next}),{mode:0o600}); await rename(temporaryIndex,indexPath);
        entries=next;recent.set(record.id,record);if(recent.size>20)recent.delete(recent.keys().next().value);
      });
      return queue;
    },
    async readMetadata() {
      // Overview needs only the last committed index, never the large detail files
      // or an in-flight prompt write queue.
      await load();
      return entries.map(item => ({...item}));
    },
    async readDetail(id) {
      await load();
      const item = entries.find(entry => entry.id === id);
      if (!item) return null;
      if (recent.has(id)) return {...item, ...recent.get(id)};
      if (item.detailStored) {
        try { return {...item, ...JSON.parse(await readFile(detailPath(id), 'utf8'))}; }
        catch(error) { if(error.code === 'ENOENT') return null; throw error; }
      }
      try {
        const legacy = JSON.parse(await readFile(legacyPath, 'utf8')).requests || [];
        return legacy.find(entry => entry.id === id) || null;
      } catch(error) { if(error.code === 'ENOENT') return null; throw error; }
    },
    async read() {
      await queue.catch(()=>{}); await load();
      const tail=entries.slice(-20), missingLegacy=tail.filter(item=>!item.detailStored&&!recent.has(item.id));
      if(missingLegacy.length){
        const wanted=new Set(missingLegacy.map(item=>item.id));
        const legacy=JSON.parse(await readFile(legacyPath,'utf8')).requests || [];
        for(const item of legacy)if(wanted.has(item.id))recent.set(item.id,item);
      }
      await Promise.all(tail.filter(item=>item.detailStored&&!recent.has(item.id)).map(async item=>{
        try{recent.set(item.id,JSON.parse(await readFile(detailPath(item.id),'utf8')))}catch(error){if(error.code!=='ENOENT')throw error}
      }));
      const ids=new Set(tail.map(item=>item.id));
      for(const id of recent.keys())if(!ids.has(id))recent.delete(id);
      return entries.map(item=>ids.has(item.id)?{...item,...recent.get(item.id)}:item);
    }
  };
}
