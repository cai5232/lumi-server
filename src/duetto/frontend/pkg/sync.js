(function(){
  if(window.__LS_SYNC_LOADED)return;window.__LS_SYNC_LOADED=true;
  function room(){ return new URLSearchParams(location.search).get('room') || localStorage.getItem('ls.room') || 'main'; }
  var ws=null, connected=false, applying=false, aiPending={}, aiSeq=0;
  function wsurl(){ var proto=location.protocol==='https:'?'wss:':'ws:'; var path=window.__LS_WS||'/ws'; var tk=(window.__duettoToken&&window.__duettoToken())||''; return proto+'//'+location.host+path+'?room='+encodeURIComponent(room())+(tk?('&token='+encodeURIComponent(tk)):''); }
  function connect(){
    try{ ws=new WebSocket(wsurl()); }catch(e){ setTimeout(connect,3000); return; }
    ws.onopen=function(){ connected=true; };
    ws.onmessage=function(ev){ try{ var m=JSON.parse(ev.data); if(m&&m.t==='ai'){ var cb=aiPending[m.id]; if(cb){ delete aiPending[m.id]; try{window.__lsLastThink=String(m.think||'');}catch(e){} cb(m.reply); } return; } if(m&&m.t==='chat'){ if(window.__lsRoomChatIn) window.__lsRoomChatIn(m.msg); return; } applying=true; if(window.__lsApplyRemote) window.__lsApplyRemote(m); }catch(e){} finally{ applying=false; } };
    ws.onclose=function(){ connected=false; setTimeout(connect,3000); };
    ws.onerror=function(){};
  }
  window.__LS_SYNC={
    send:function(m){ if(applying)return; if(ws&&ws.readyState===1) ws.send(JSON.stringify(m)); },
    connected:function(){return connected;},
    room:room,
    aiSend:function(prompt, ai){ return new Promise(function(res){ if(!ws||ws.readyState!==1){ res(null); return; } var id='ai'+(++aiSeq); aiPending[id]=res; var msg={t:'ai',id:id,prompt:prompt}; if(ai)msg.ai=ai; ws.send(JSON.stringify(msg)); setTimeout(function(){ if(aiPending[id]){ delete aiPending[id]; res(null); } },45000); }); }
  };
  if(document.readyState!=='loading')connect();else document.addEventListener('DOMContentLoaded',connect);
})();
