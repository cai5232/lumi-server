// Tools are adapters over Lumi's existing Nocturne functions. This module has
// no storage and never writes as a side effect of retrieval.
export function createNocturneTools({ search, write, get, update, trace, allowWrites = false }) {
  const string = { type: 'string', minLength: 1 };
  const schema = properties => ({ type:'object',properties,required:Object.keys(properties),additionalProperties:false });
  const tools = [
    { name:'memory_search', description:'检索 nocturne 长期记忆；只读，不会写入。新记忆请在回复末尾使用 <memory>内容</memory> 标签。',input_schema:schema({query:{...string,maxLength:800}}) },
    ...(allowWrites ? [{ name:'memory_write', description:'将值得长期保留的新事实或共同经历写入 nocturne。不要重新保存检索结果；成功后不要再输出相同内容的 memory 标记。',input_schema:schema({content:{...string,maxLength:3500}}) }] : []),
    ...(get?[{name:'memory_get',description:'按真实记忆 ID 读取 nocturne 完整原文；只读，不会写入。',input_schema:schema({id:{...string,maxLength:200}})}]:[]),
    ...(allowWrites && update?[{name:'memory_update',description:'更新 nocturne 中已存在的记忆。先读取实际原文，仅纠正明确的新信息，不要将检索结果另存为新记忆。',input_schema:schema({id:{...string,maxLength:200},content:{...string,maxLength:3500}})}]:[]),
  ];
  return { tools, async execute(name,args) {
    if (name==='memory_search') return await search(args.query);
    if (name==='memory_get' && get) return await get(args.id);
    if (!allowWrites) return {isError:true,error:'memory_tool_read_only_use_memory_tag'};
    const canonical = name==='memory_write' ? {content:String(args.content||'').trim()} : {id:args.id,content:String(args.content||'').trim()};
    if (!canonical.content) return {isError:true,error:'empty_memory'};
    const argumentsJSON=JSON.stringify(canonical);
    const duplicate=trace.some(t=>t.name===name&&t.succeeded&&t.arguments===argumentsJSON);
    if(duplicate)return {saved:true,duplicate:true};
    let result;
    try {
      result = name==='memory_write' ? {saved:await write(canonical.content)}
        : name==='memory_update' && update ? await update(canonical.id,canonical.content)
        : {isError:true,error:'memory_tool_unavailable'};
      if(result.saved===false)result.isError=true;
    } catch(error){result={isError:true,error:String(error.message||error).slice(0,300)};}
    trace.push({time:new Date().toISOString(),name,arguments:argumentsJSON,result:JSON.stringify(result),succeeded:!result.isError});
    return result;
  }};
}
