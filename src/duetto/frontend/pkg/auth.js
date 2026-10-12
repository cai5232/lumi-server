/* Lumi's native app authenticates this embedded Duetto view with its existing
   Lumi API credential. No Duetto PIN is requested in the front end. */
(function(){
  if (window.__DUETTO_AUTH) return; window.__DUETTO_AUTH = 1;
  var TK = 'duetto-token';
  function tok(){ try { return localStorage.getItem(TK) || ''; } catch(e){ return ''; } }
  window.__duettoToken = tok;
  var _f = window.fetch.bind(window);
  function notice(message){
    if (!document.body) { document.addEventListener('DOMContentLoaded', function(){ notice(message); }, { once: true }); return; }
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#f8f0f3;font-family:system-ui,-apple-system,"Noto Serif SC",serif;color:#75676d;text-align:center;padding:24px;box-sizing:border-box;';
    el.innerHTML = '<div style="max-width:300px;background:#fff;border-radius:24px;padding:30px 26px;box-shadow:0 12px 36px rgba(90,50,65,.10)"><div style="font-size:22px;font-weight:700;color:#332b2e;margin-bottom:12px">一起听</div><div style="font-size:15px;line-height:1.7">' + message + '</div></div>';
    document.body.appendChild(el);
  }
  window.fetch = function(input, init){
    var url = ''; try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch(e){}
    var api = window.__LS_API || '/api';
    var isApi = url.indexOf(api) === 0 || url.indexOf('/api/') === 0;
    if (isApi) { init = init ? Object.assign({}, init) : {}; var t = tok(); var h = Object.assign({}, init.headers || {}); if (t) h['Authorization'] = 'Bearer ' + t; init.headers = h; }
    return _f(input, init).then(function(r){ if (isApi && r && r.status === 401 && url.indexOf('/auth/') < 0) notice('Lumi 授权已失效，请重新打开页面。'); return r; });
  };
  function boot(){
    var lumiToken = String(window.__LUMI_PUSH_API_TOKEN || '');
    window.__LUMI_PUSH_API_TOKEN = '';
    if (!lumiToken) {
      notice(window.__LUMI_NATIVE_APP
        ? 'Lumi 服务授权尚未配置，请先在 Lumi 聊天设置中配置服务器口令。'
        : '请从 Lumi App 内打开“一起听”。');
      return;
    }
    var api = window.__LS_API || '/api';
    _f(api + '/auth/session', { method: 'POST', headers: { 'Authorization': 'Bearer ' + lumiToken } })
      .then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(j){
        if (!j || !j.ok || !j.token) { notice('Lumi 授权失败，请检查 App 的服务器连接。'); return; }
        var previous = tok();
        try { localStorage.setItem(TK, j.token); } catch(e){}
        if (previous !== j.token) location.reload();
      })
      .catch(function(){ notice('无法连接 Lumi 服务，请稍后重试。'); });
  }
  if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
