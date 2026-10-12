(function(){
  var API=window.__LS_API||'/api';
  // 取当前在放的歌：优先显式传入，其次全局 __lsNowPlaying / ncmSong
  function nowPlaying(opts){
    if(opts&&opts.nowPlaying)return opts.nowPlaying;
    var g=window.__lsNowPlaying;
    if(g&&g.title){ var o={title:g.title,artist:g.artist||'',id:g.id||''}; try{ var au=window.__lsAudioEl; if(au&&au.duration&&isFinite(au.duration)){ o.pos=Math.floor(au.currentTime||0); o.dur=Math.floor(au.duration); if(/^https?:/.test(String(au.src||'')))o.url=au.src; } }catch(e){} try{ if(window.__lsCurLyric) o.cur_lyric=String(window.__lsCurLyric).slice(0,80); }catch(e){} return o; }
    var n=window.ncmSong;
    if(n&&n.title)return {title:n.title,artist:n.artist||''};
    return null;
  }
  function historyOf(opts){
    var h=(opts&&opts.history);
    return Array.isArray(h)?h:null;
  }
  // 组装发给后端的 ai 对象：含部署者/用户人设 persona + 可选自定义端点密钥
  function aiConfig(){
    var mm=(window.__lsStore&&window.__lsStore.model)||{};
    var m=mm.chat||mm;
    var ai={};
    if(m.endpoint&&m.key){
      ai.base_url=m.endpoint;ai.api_key=m.key;
      var mn=m.name||m.model||'';
      if(mn)ai.model=mn; // 空 model 不发：否则会覆盖服务端 settings 里的模型名，上游报 model name empty
    }
    var persona=(window.__lsStore&&window.__lsStore.persona)||'';
    if(persona)ai.persona=persona;
    try{var st=(window.__lsStore&&window.__lsStore.style)||'';if(st)ai.style=st;}catch(e){}
    // 昵称与时间感知随每次请求带给后端（前端设置是唯一真相）
    try{var P=window.LS_PEOPLE;if(P){if(P.yu&&P.yu.name)ai.ai_name=P.yu.name;if(P.eve&&P.eve.name)ai.user_name=P.eve.name;}}catch(e){}
    try{ai.time_aware=localStorage.getItem('ls-room-timeaware')!=='0';}catch(e){}
    try{if(localStorage.getItem('ls-room-replymode')==='stream')ai.reply_mode='stream';}catch(e){}
    // 分析模型三件套：后端生成"听后印象"时优先用它（比如 gemini）
    try{var ma=(mm.analysis||{});if(ma.endpoint)ai.a_base=ma.endpoint;if(ma.key)ai.a_key=ma.key;if(ma.name)ai.a_model=ma.name;}catch(e){}
    return ai;
  }
  function fetchComplete(prompt, ai, np, history){
    var body={kind:'music',prompt:String(prompt||''),ai:ai};
    if(np)body.nowPlaying=np;
    if(history)body.history=history;
    return fetch(API+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json();})
      .then(function(d){ if(d&&d.ok){ try{window.__lsLastThink=String(d.think||'');}catch(e){} return d.reply||''; } return '[AI not set up yet - add your endpoint + key in Settings or the Model tab]'; })
      .catch(function(e){ return '[AI error: '+(e&&e.message||e)+']'; });
  }
  function complete(prompt, opts){
    var ai=aiConfig();
    var np=nowPlaying(opts);
    var history=historyOf(opts);
    // WS 通道只转发 prompt+ai：把上下文一并挂进 ai，后端 WS 处理器会读取
    if(opts&&opts.noNote)ai.no_note=1;
    if(opts&&opts.quote)ai.quote=String(opts.quote);
    if(window.__LS_SYNC&&window.__LS_SYNC.aiSend){
      var wsAi={};
      for(var k in ai)wsAi[k]=ai[k];
      if(np)wsAi.nowPlaying=np;
      if(history)wsAi.history=history;
      return window.__LS_SYNC.aiSend(String(prompt||''), wsAi).then(function(reply){ return (reply!=null)?reply:fetchComplete(prompt, ai, np, history); });
    }
    return fetchComplete(prompt, ai, np, history);
  }
  window.claude={ complete: complete, ask: complete };
  window.__lsAiConfig=aiConfig;
})();
