/* Duetto 应用级门禁：首次打开设 PIN，之后新设备输 PIN 换 token。
   fetch 全局拦截加 Bearer；401 自动弹门。网易云登录只是登网易账号——这道门才是应用自己的锁。 */
(function(){
  if (window.__DUETTO_AUTH) return; window.__DUETTO_AUTH = 1;
  var TK = 'duetto-token';
  function tok(){ try { return localStorage.getItem(TK) || ''; } catch(e){ return ''; } }
  window.__duettoToken = tok;
  var _f = window.fetch.bind(window);
  window.fetch = function(input, init){
    var url = ''; try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch(e){}
    var api = window.__LS_API || '/api';
    var isApi = url.indexOf(api) === 0 || url.indexOf('/api/') === 0;
    if (isApi) { init = init ? Object.assign({}, init) : {}; var t = tok(); var h = Object.assign({}, init.headers || {}); if (t) h['Authorization'] = 'Bearer ' + t; init.headers = h; }
    return _f(input, init).then(function(r){ if (isApi && r && r.status === 401 && url.indexOf('/auth/') < 0) show('login'); return r; });
  };
  var el = null, showing = '';
  function show(mode){
    if (showing === mode) return; showing = mode;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    var setup = mode === 'setup';
    el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#eceae6;font-family:system-ui,-apple-system,"Noto Serif SC",serif;';
    el.innerHTML = '<div style="width:min(320px,86vw);background:#fff;border-radius:22px;padding:30px 26px;box-shadow:0 18px 50px rgba(0,0,0,.12);text-align:center">'
      + '<div style="font-size:22px;font-weight:700;letter-spacing:.06em;margin-bottom:6px">Duetto</div>'
      + '<div style="font-size:13px;color:#8b8680;margin-bottom:20px">' + (setup ? '给你们的 Duetto 设一道门禁 PIN（至少 4 位）' : '输入门禁 PIN') + '</div>'
      + '<input id="du-pin" type="password" inputmode="numeric" placeholder="PIN" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #ddd8d0;border-radius:12px;font-size:16px;text-align:center;letter-spacing:.3em;margin-bottom:10px">'
      + (setup ? '<input id="du-pin2" type="password" inputmode="numeric" placeholder="再输一次" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #ddd8d0;border-radius:12px;font-size:16px;text-align:center;letter-spacing:.3em;margin-bottom:10px">' : '')
      + '<div id="du-err" style="min-height:18px;font-size:12px;color:#c0392b;margin-bottom:8px"></div>'
      + '<button id="du-go" style="width:100%;padding:12px;border:none;border-radius:12px;background:#2f2b26;color:#fff;font-size:15px;cursor:pointer">' + (setup ? '设置并进入' : '进入') + '</button></div>';
    document.body.appendChild(el);
    var err = el.querySelector('#du-err');
    var go = function(){
      var p1 = el.querySelector('#du-pin').value || '';
      if (setup) { var p2v = (el.querySelector('#du-pin2') || {}).value || ''; if (p1.length < 4) { err.textContent = 'PIN 至少 4 位'; return; } if (p1 !== p2v) { err.textContent = '两次输入不一致'; return; } }
      var api = window.__LS_API || '/api';
      _f(api + '/auth/' + (setup ? 'setup' : 'login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: p1 }) })
        .then(function(r){ return r.json().catch(function(){ return {}; }); })
        .then(function(j){ if (j && j.ok && j.token) { try { localStorage.setItem(TK, j.token); } catch(e){} location.reload(); } else { err.textContent = (j && j.error) || '失败了，再试一次'; } })
        .catch(function(){ err.textContent = '连不上服务器'; });
    };
    el.querySelector('#du-go').onclick = go;
    el.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') go(); });
    setTimeout(function(){ try { el.querySelector('#du-pin').focus(); } catch(e){} }, 120);
  }
  function boot(){
    var api = window.__LS_API || '/api';
    _f(api + '/auth/status').then(function(r){ return r.json(); }).then(function(d){
      if (!d || !d.ok) return;
      if (!d.configured) show('setup');
      else if (!tok()) show('login');
    }).catch(function(){});
  }
  if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
