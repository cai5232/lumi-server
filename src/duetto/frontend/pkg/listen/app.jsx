/* listen/app.jsx — 「一起听歌」根。
   底栏：此刻(播放) · 歌单(资料) · 曲库(搜索+日推+FM) · 一起听(档案+歌库+设置)。
   播放页：黑胶/卡片封面切换、滑动切纯歌词、队列、播放方式、问 Ta、详情抽屉。 */

const { useState: aUseState, useEffect: aUseEffect, useRef: aUseRef } = React;

const LS_SKINS = [
  { id: 'ningzhi',  name: '凝脂',     po: 'cool cream',   bg: '#efece7', ac: '#b29a6e' },
  { id: 'douqing',  name: '豆青',     po: 'sage light',   bg: '#eaede2', ac: '#8a9a6b' },
  { id: 'xueqing',  name: '雪青',     po: 'misty violet', bg: '#f0f1fa', ac: '#8f93c9' },
  { id: 'ouhe',     name: '藕荷',     po: 'soft rose',    bg: '#f5eef0', ac: '#c08c9b' },
  { id: 'jilan',    name: '霁蓝',     po: 'misty blue',   bg: '#e9eef4', ac: '#7d9ac6' },
];

var lsAudioEl = window.__lsAudioEl || (window.__lsAudioEl = (function(){ var a = document.createElement('audio');  a.preload = 'none'; a.setAttribute('playsinline',''); a.setAttribute('webkit-playsinline',''); a.style.display='none'; try{ (document.body||document.documentElement).appendChild(a); }catch(e){} return a; })());
window.__lsAdv = window.__lsAdv || { list: null, idx: 0, kind: '', mode: 'loop', plan: [] };
function lsMarkLoad(){ window.__lsInternalLoad = Date.now(); }
function lsSetAdv(list, idx, kind){ var A = window.__lsAdv; A.list = list || null; A.idx = idx || 0; A.kind = kind || ''; A.plan = []; }
function lsPrefetchNext(){
  var A = window.__lsAdv; if (!A || !A.list || !A.list.length || A.mode === 'one') return;
  var n = A.list.length, ni;
  if (A.kind === 'fm') ni = A.idx + 1;
  else if (n < 2) return;
  else if (A.mode === 'shuffle'){ while (A.plan.length < 3){ var r = Math.floor(Math.random()*n), g=0; while ((r===A.idx || A.plan.indexOf(r)>=0) && g++<12) r=Math.floor(Math.random()*n); A.plan.push(r); } ni = A.plan[0]; }
  else ni = (A.idx + 1) % n;
  var ns = A.list[ni]; if (!ns || !ns.id || ns.url) return;
  var map = window.__lsPrefetchMap = window.__lsPrefetchMap || {};
  if (map[String(ns.id)]) return;
  map[String(ns.id)] = '';
  var base = window.__LS_API || '/api';
  fetch(base + '/ncm/song-url?id=' + ns.id).then(function(r){ return r.json(); }).then(function(d){ if (d && d.url) map[String(ns.id)] = d.url; else delete map[String(ns.id)]; }).catch(function(){ delete map[String(ns.id)]; });
}
var LS_DEMO_SRC = [];
function LSApp() {
  const [skin, setSkin] = aUseState(() => { try { return localStorage.getItem('ls-skin') || 'ouhe'; } catch (e) { return 'ouhe'; } });
  const [customAc, setCustomAc] = aUseState(() => localStorage.getItem('ls-skin-custom') || '#c99bb0');
  const [customVars, setCustomVars] = aUseState(() => { try { return JSON.parse(localStorage.getItem('ls-skin-diy') || '{}'); } catch (e) { return {}; } });
  const [darkMode, setDarkMode] = aUseState(() => { try { return localStorage.getItem('ls-dark') === '1'; } catch (e) { return false; } });
  const [view, setView] = aUseState('player');         // player | playlist | browse | together
  const [idx, setIdx]   = aUseState(0);
  const [playing, setPlaying] = aUseState(false);
  const [cur, setCur]   = aUseState(0);
  const [loved, setLoved] = aUseState(false);
  const [coverMode, setCoverMode] = aUseState(() => localStorage.getItem('ls-cover') || 'vinyl');
  const [playMode, setPlayMode] = aUseState(() => localStorage.getItem('ls-playmode') || 'loop');
  const [skinOpen, setSkinOpen] = aUseState(false);
  const [togetherTab, setTogetherTab] = aUseState('archive');  // archive | library | model
  // A–F
  const [store] = aUseState(() => { const s = lsLoadStore(); window.__lsStore = s; return s; });
  const [, setTick] = aUseState(0);
  const bump = () => setTick(t => t + 1);
  const [drawerIdx, setDrawerIdx] = aUseState(null);
  const [ask, setAsk] = aUseState(null);
  const [modelOpen, setModelOpen] = aUseState(false);
  const [queueOpen, setQueueOpen] = aUseState(false);
  const [fmOpen, setFmOpen] = aUseState(false);
  const [commentsIdx, setCommentsIdx] = aUseState(null);
  const [commentsSong, setCommentsSong] = aUseState(null);
  const [savePickerSong, setSavePickerSong] = aUseState(null);
  window.__lsSavePicker = (s) => setSavePickerSong(s);
  const [wallOn, setWallOn] = aUseState(() => localStorage.getItem('ls-wall') === '1');
  const [wallVeil, setWallVeil] = aUseState(() => Number(localStorage.getItem('ls-wall-veil') || 0.4));
  const [wallBlur, setWallBlur] = aUseState(() => Number(localStorage.getItem('ls-wall-blur') || 0));
  const [cardVeil, setCardVeil] = aUseState(() => Number(localStorage.getItem('ls-card-veil') || 0));
  const [cardBlur, setCardBlur] = aUseState(() => Number(localStorage.getItem('ls-card-blur') || 0));
  const [navVeil, setNavVeil] = aUseState(() => { const v = localStorage.getItem('ls-nav-veil'); return v == null ? 0.7 : Number(v); });
  const [navBlur, setNavBlur] = aUseState(() => { const v = localStorage.getItem('ls-nav-blur'); return v == null ? 14 : Number(v); });
  const [openPl, setOpenPl] = aUseState(null);
  const [roomOpen, setRoomOpen] = aUseState(false);
  const [roomTab, setRoomTab] = aUseState('chat');
  const [ncmSong, setNcmSong] = aUseState(null);
  const [ncmLyric, setNcmLyric] = aUseState('');
  const [ncmQueue, setNcmQueue] = aUseState(null);
  const [ncmDrawerSong, setNcmDrawerSong] = aUseState(null);
  const fmFetchRef = aUseRef({ busy: false });

  aUseEffect(() => { localStorage.setItem('ls-skin', skin); }, [skin]);
  aUseEffect(() => { localStorage.setItem('ls-cover', coverMode); }, [coverMode]);
  aUseEffect(() => { localStorage.setItem('ls-wall', wallOn ? '1' : '0'); }, [wallOn]);
  aUseEffect(() => { localStorage.setItem('ls-wall-veil', wallVeil); }, [wallVeil]);
  aUseEffect(() => { localStorage.setItem('ls-wall-blur', wallBlur); }, [wallBlur]);
  aUseEffect(() => { localStorage.setItem('ls-card-veil', cardVeil); }, [cardVeil]);
  aUseEffect(() => { localStorage.setItem('ls-card-blur', cardBlur); }, [cardBlur]);
  aUseEffect(() => { localStorage.setItem('ls-nav-veil', navVeil); }, [navVeil]);
  aUseEffect(() => { localStorage.setItem('ls-nav-blur', navBlur); }, [navBlur]);
  aUseEffect(() => { localStorage.setItem('ls-playmode', playMode); }, [playMode]);

  const cyclePlayMode = () => setPlayMode(m => m === 'loop' ? 'one' : m === 'one' ? 'shuffle' : 'loop');
  const libHas = (songId) => (window.__lsStore.library || []).some(x => x.songId === songId);
  const addToLib = (song) => {
    const s = window.__lsStore;
    if (!s.library.some(x => x.songId === song.id)) {
      s.library.unshift({ songId: song.id, title: song.title, artist: song.artist, cover: song.cover, pinned: false, notes: 0, last: Date.now() });
      lsSaveStore(s); bump();
    }
  };
  const openSongById = (songId) => { const i = LS_SONGS.findIndex(s => s.id === songId); if (i >= 0) { setIdx(i); setDrawerIdx(i); } };
  const playSong = (song) => { setNcmSong(null); setNcmQueue(null); const i = LS_SONGS.findIndex(s => s.id === song.id); if (i >= 0) { setIdx(i); setCur(0); setPlaying(true); setView('player'); } };
  const logListen = (s, url) => { try { fetch((window.__LS_API || '/api') + '/listen-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id, title: s.title, artist: s.artist || '', dur: s.dur || 0, cover: s.cover || '', url: (url && /^https?:/.test(String(url))) ? String(url) : '' }) }).catch(function(){}); } catch (e) {} };
  const loadNcm = (s) => {
    const base = window.__LS_API || '/api';
    // 就绪即播：新 src 常在 loadstart（未就绪）时就调 play() → 不产生 playing → 无声。
    // 立即试一次，并挂一次性 canplay/loadeddata 监听在真正可播时补一次（iOS 后台续播关键）。
    const playSoon = function(){
      try { const p = lsAudioEl.play(); if (p && p.catch) p.catch(function(){}); } catch(e){}
      const retry = function(){ try { if (window.__lsPlaying && lsAudioEl.paused) { const p2 = lsAudioEl.play(); if (p2 && p2.catch) p2.catch(function(){}); } } catch(e){} lsAudioEl.removeEventListener('canplay', retry); lsAudioEl.removeEventListener('loadeddata', retry); };
      lsAudioEl.addEventListener('canplay', retry); lsAudioEl.addEventListener('loadeddata', retry);
    };
    setNcmLyric(''); setLoved(false);

    // 本地链接歌（用户在"本地"里自己添加的直链）：直接播，不走网易云
    if (s && s.url) { lsMarkLoad(); lsAudioEl.src = s.url; playSoon(); logListen(s, s.url); lsPrefetchNext(); return; }
    // 预取命中：上一首快放完时已把这首的 URL 取好，切歌零 fetch —— 后台（锁屏）续播不断
    const pf = window.__lsPrefetch;
    const pmapUrl = (window.__lsPrefetchMap || {})[String(s.id)] || '';
    const hitUrl = (pf && String(pf.id) === String(s.id) && pf.url) || pmapUrl;
    if (hitUrl) {
      lsMarkLoad(); lsAudioEl.src = hitUrl; playSoon();
      try { delete window.__lsPrefetchMap[String(s.id)]; } catch (e) {}
      logListen(s, hitUrl);
      window.__lsPrefetch = null;
      fetch(base + '/ncm/lyric?id=' + s.id).then(r => r.json()).then(l => { window.__lsTLyric = (l && l.tlyric) || ''; setNcmLyric((l && l.lyric) || ''); }).catch(function(){});
      lsPrefetchNext();
      return;
    }
    fetch(base + '/ncm/song-url?id=' + s.id).then(r => r.json()).then(d => { if (d && d.url) { lsMarkLoad(); lsAudioEl.src = d.url; playSoon(); logListen(s, d.url); } else { logListen(s, ''); } }).catch(function(){ logListen(s, ''); });
    fetch(base + '/ncm/lyric?id=' + s.id).then(r => r.json()).then(l => { window.__lsTLyric = (l && l.tlyric) || ''; setNcmLyric((l && l.lyric) || ''); }).catch(function(){});
    lsPrefetchNext();
  };
  const requestFmMore = (opts) => {
    opts = opts || {};
    if (opts.playAfterAppend) fmFetchRef.current.playAfterAppend = true;
    if (fmFetchRef.current.busy) return;
    fmFetchRef.current.busy = true;
    const base = window.__LS_API || '/api';
    fetch(base + '/ncm/personal-fm').then(function (r) { return r.json(); }).then(function (d) {
      const shouldAutoPlay = !!fmFetchRef.current.playAfterAppend;
      const more = ((d && d.songs) || []).filter(Boolean);
      if (!more.length) { if (shouldAutoPlay) setPlaying(false); return; }
      setNcmQueue(function (q) {
        if (!q || q.kind !== 'fm') return q;
        const seen = {};
        (q.list || []).forEach(function (x) { if (x && x.id != null) seen[String(x.id)] = true; });
        let add = more.filter(function (x) { const k = String(x.id); if (seen[k]) return false; seen[k] = true; return true; });
        if (!add.length) add = more;
        const list = (q.list || []).concat(add);
        const shouldPlay = shouldAutoPlay && q.idx >= ((q.list || []).length - 1);
        if (shouldPlay) {
          const ni = (q.list || []).length;
          const ns = list[ni];
          // 同步推进游标：新歌进 __lsAdv，切歌/续播/后台都以它为准
          if (window.__lsAdv) { window.__lsAdv.list = list; window.__lsAdv.idx = ni; window.__lsAdv.kind = 'fm'; }
          if (ns) { setNcmSong(ns); setCur(0); setPlaying(true); loadNcm(ns); }
          return { ...q, list: list, idx: ni, kind: 'fm' };
        }
        // 只是把批次续长：游标的 list 也跟着变长（idx 不动）
        if (window.__lsAdv) { window.__lsAdv.list = list; window.__lsAdv.kind = 'fm'; }
        return { ...q, list: list, kind: 'fm' };
      });
    }).catch(function () { if (fmFetchRef.current.playAfterAppend) setPlaying(false); }).finally(function () { fmFetchRef.current.busy = false; fmFetchRef.current.playAfterAppend = false; });
  };
  // FM 是未知流：切到当前已知队列最后一首时，再向网易云要下一批。
  aUseEffect(() => {
    if (!ncmQueue || ncmQueue.kind !== 'fm' || !ncmQueue.list || !ncmQueue.list.length) return;
    if (ncmQueue.list.length - ncmQueue.idx <= 1) requestFmMore();
  }, [ncmQueue && ncmQueue.kind, ncmQueue && ncmQueue.idx, ncmQueue && ncmQueue.list && ncmQueue.list.length]);

  // 开播即预取下一首的播放地址：不等尾窗（歌尾可能已在 iOS 后台、fetch 会被掐），前台就把地址备好，ended 零网络切歌
  aUseEffect(() => {
    if (!ncmQueue || !ncmQueue.list || !ncmQueue.list.length || playMode === 'one') return;
    const curSong = ncmQueue.list[ncmQueue.idx];
    if (cur < 2) return;
    const isFm = ncmQueue.kind === 'fm';
    if (isFm && ncmQueue.list.length - ncmQueue.idx <= 1) requestFmMore();
    if (ncmQueue.list.length < 2) return;
    const pf0 = window.__lsPrefetch;
    if (pf0 && pf0.forCur === String((curSong && curSong.id) || '')) return;
    let ni = ncmQueue.idx + 1;
    if (!isFm) {
      ni = ni % ncmQueue.list.length;
      if (playMode === 'shuffle') {
        // 计划链：提前抽好接下来 3 首的随机顺序，ended 依次消费——后台连切也有粮
        const len = ncmQueue.list.length;
        let plan = (window.__lsShufflePlan || []).filter(x => x >= 0 && x < len);
        while (plan.length < 3) { let r = Math.floor(Math.random() * len); const avoid = [ncmQueue.idx].concat(plan); if (len > avoid.length) { let g = 0; while (avoid.indexOf(r) >= 0 && g++ < 12) r = Math.floor(Math.random() * len); } plan.push(r); }
        window.__lsShufflePlan = plan;
        ni = plan[0];
      } else if (window.__lsShufflePlan && window.__lsShufflePlan.length) window.__lsShufflePlan = [];
    }
    if (ni >= ncmQueue.list.length) return;
    const nxt = ncmQueue.list[ni];
    if (!nxt) return;
    const pmap = window.__lsPrefetchMap = window.__lsPrefetchMap || {};
    window.__lsPrefetch = { id: nxt.id, url: nxt.url || pmap[String(nxt.id)] || null, idx: ni, forCur: String((curSong && curSong.id) || '') };
    const base = window.__LS_API || '/api';
    const grab = (sg) => {
      if (!sg || !sg.id || sg.url || pmap[String(sg.id)]) return;
      pmap[String(sg.id)] = '';
      fetch(base + '/ncm/song-url?id=' + sg.id).then(r => r.json()).then(d2 => {
        if (d2 && d2.url) { pmap[String(sg.id)] = d2.url; if (window.__lsPrefetch && String(window.__lsPrefetch.id) === String(sg.id)) window.__lsPrefetch.url = d2.url; }
        else delete pmap[String(sg.id)];
      }).catch(function(){ delete pmap[String(sg.id)]; });
    };
    grab(nxt);
    // 再往后多备两首，整段后台都有粮（随机按计划链，FM/顺序按队列）
    const keep = { [String(nxt.id)]: 1 };
    if (playMode === 'shuffle' && !isFm) { (window.__lsShufflePlan || []).forEach(pi => { const sg = ncmQueue.list[pi]; if (sg) { grab(sg); keep[String(sg.id)] = 1; } }); }
    else { for (let k = 2; k <= 3; k++) { const j = isFm ? (ncmQueue.idx + k) : ((ncmQueue.idx + k) % ncmQueue.list.length); const sg = ncmQueue.list[j]; if (j < ncmQueue.list.length && sg) { grab(sg); keep[String(sg.id)] = 1; } } }
    try { Object.keys(pmap).forEach(id => { if (!keep[id]) delete pmap[id]; }); } catch (e) {}
  }, [cur, ncmQueue, playMode]);
  window.__lsPlayNcm = (song, list, i0) => {
    var lst = (list && list.length) ? list : [song];
    var i = (i0 != null) ? Number(i0) : ((list && list.length) ? lst.findIndex(function(x){ return String(x.id) === String(song.id); }) : 0);
    if (i < 0 || i >= lst.length) i = 0;
    window.__lsPrefetch = null; lsSetAdv(lst, i, '');
    setNcmQueue({ list: lst, idx: i });
    setNcmSong(lst[i]); setCur(0); setView('player'); setPlaying(true);
    loadNcm(lst[i]);
  };
  window.__lsStartFm = (songs, i0) => {
    var lst = Array.isArray(songs) ? songs.filter(Boolean) : (songs ? [songs] : []);
    if (!lst.length) return;
    var i = Math.max(0, Math.min(lst.length - 1, Number(i0) || 0));
    window.__lsPrefetch = null; lsSetAdv(lst, i, 'fm');
    setNcmQueue({ list: lst, idx: i, kind: 'fm' });
    if (playMode === 'one') setPlayMode('loop');
    setNcmSong(lst[i]); setCur(0); setView('player'); setPlaying(true); setFmOpen(false);
    loadNcm(lst[i]);
    if (lst.length - i <= 1) requestFmMore();
  };
  const playNcmIdx = (i) => {
    var q = ncmQueue; if (!q || !q.list || !q.list.length) return;
    var ni;
    if (q.kind === 'fm') {
      ni = Math.max(0, Number(i) || 0);
      if (ni >= q.list.length) { requestFmMore({ playAfterAppend: true }); return; }
    } else {
      ni = ((i % q.list.length) + q.list.length) % q.list.length;
    }
    lsSetAdv(q.list, ni, q.kind);
    setNcmQueue({ ...q, idx: ni });
    setNcmSong(q.list[ni]); setCur(0); setPlaying(true);
    loadNcm(q.list[ni]);
    if (q.kind === 'fm' && q.list.length - ni <= 1) requestFmMore();
  };
  // 全局房间事件出口：谁操作（用户/AI 4 秒标记）拼谁的昵称；房间开着就本地上屏，同时广播落库
  window.__lsRoomEvent = (tail) => {
    try {
      const actor = window.__lsActor;
      const isAI = actor && actor.who === 'ai' && (Date.now() - actor.t) < 4000;
      const who = isAI ? ((window.LS_PEOPLE && window.LS_PEOPLE.yu && window.LS_PEOPLE.yu.name) || 'AI') : ((window.LS_PEOPLE && window.LS_PEOPLE.eve && window.LS_PEOPLE.eve.name) || '我');
      const d0 = new Date(); const tm = (d0.getHours() < 10 ? '0' : '') + d0.getHours() + ':' + (d0.getMinutes() < 10 ? '0' : '') + d0.getMinutes();
      const msg = { who: 'sys', t: who + ' ' + tail, time: tm, sys: true, ts: Date.now() };
      if (window.__lsRoomChatIn) window.__lsRoomChatIn(msg);
      if (window.__LS_SYNC && window.__LS_SYNC.send) window.__LS_SYNC.send({ t: 'chat', msg });
    } catch (e) {}
  };
  // App 级状态卡：播放/暂停/切歌/换模式——不管房间开没开，本页面的真实操作都记录（系统/远程同步事件除外）
  const sysCardRef = aUseRef({ init: false });
  aUseEffect(() => {
    const s = sysCardRef.current;
    const cur = (ncmQueue && ncmQueue.list && ncmQueue.list.length) ? ncmQueue.list[ncmQueue.idx] : (ncmSong || LS_SONGS[idx]);
    const title = (cur && cur.title) || ''; const art = (cur && cur.artist) || ''; const pm = playMode || '';
    if (!s.init) { s.init = true; s.title = title; s.playing = playing; s.mode = pm; return; }
    const quiet = (window.__lsSysEvt && (Date.now() - window.__lsSysEvt) < 3000) || (window.__lsRemoteEvt && (Date.now() - window.__lsRemoteEvt) < 3000);
    const msgs = [];
    if (title && title !== s.title) { if (!quiet) msgs.push('播放了《' + title + '》' + (art ? ' ' + art : '')); }
    else {
      if (playing !== s.playing && !quiet) msgs.push((playing ? '继续播放' : '暂停了') + (title ? ' 《' + title + '》' : ''));
      if (pm !== s.mode) msgs.push('切换到' + (pm === 'one' ? '单曲循环' : pm === 'shuffle' ? '随机播放' : '列表循环'));
    }
    s.title = title; s.playing = playing; s.mode = pm;
    const fresh = msgs.filter(t => !(s.last && s.last.t === t && (Date.now() - s.last.ts) < 30000));
    if (fresh.length) { s.last = { t: fresh[fresh.length - 1], ts: Date.now() }; fresh.forEach(t => window.__lsRoomEvent && window.__lsRoomEvent(t)); }
  }, [ncmSong, ncmQueue, idx, playing, playMode]);
  // AI DJ 执行器：AI 回复里的 <<ACT>>{...}<<>> 经这里落到播放器
  window.__lsRunAction = (act) => {
    try {
      if (!act || !act.type) return;
      if (['play','next','prev','pause','resume','like','queue','share'].indexOf(act.type) < 0) return;
      // 标记操作者：房间状态卡片据此显示对应昵称（AI 点歌/切歌 vs 用户手点）
      window.__lsActor = { who: 'ai', t: Date.now() };
      var base = window.__LS_API || '/api';
      if (act.type === 'play') {
        fetch(base + '/ncm/search?kw=' + encodeURIComponent(act.query || ''))
          .then(function(r){ return r.json(); })
          .then(function(d){
            var songs = (d && d.songs) || [];
            if (songs.length && window.__lsPlayNcm) window.__lsPlayNcm(songs[0], songs, 0);
          }).catch(function(){});
      } else if (act.type === 'next') {
        if (ncmQueue) playNcmIdx(ncmQueue.idx + 1);
      } else if (act.type === 'prev') {
        if (ncmQueue) playNcmIdx(ncmQueue.idx - 1);
      } else if (act.type === 'pause') {
        setPlaying(false);
      } else if (act.type === 'resume') {
        setPlaying(true);
      } else if (act.type === 'like') {
        var qv = window.__lsEv && window.__lsEv.ncmQueue;
        var cs = (qv && qv.list && qv.list[qv.idx]) || null;
        if (cs && cs.id && /^\d+$/.test(String(cs.id))) { fetch(base + '/ncm/like?id=' + cs.id + '&like=1', { method: 'POST' }).catch(function(){}); if (window.__lsRoomEvent && cs.title) window.__lsRoomEvent('红心了《' + cs.title + '》'); }
      } else if (act.type === 'queue') {
        if (act.query) {
          fetch(base + '/ncm/search?kw=' + encodeURIComponent(act.query))
            .then(function(r){ return r.json(); })
            .then(function(d){ var s = d && d.songs && d.songs[0]; if (s && window.__lsQueueAppend) window.__lsQueueAppend(s); }).catch(function(){});
        }
      } else if (act.type === 'share') {
        // AI 分享歌曲：带 query 就搜出来贴卡片（不打断播放），不带就分享当前这首
        if (act.query) {
          fetch(base + '/ncm/search?kw=' + encodeURIComponent(act.query))
            .then(function(r){ return r.json(); })
            .then(function(d){
              var s = d && d.songs && d.songs[0]; if (!s) return;
              if (window.__lsRoomShare) window.__lsRoomShare('ai', s);
              // 推出分享卡的同时：加入播放列表（不清空队列）并切过去播
              setNcmQueue(function (q) {
                var list = (q && q.list) ? q.list.slice() : [];
                var i = list.findIndex(function (x) { return String(x.id) === String(s.id); });
                if (i < 0) { list.push(s); i = list.length - 1; }
                setNcmSong(list[i]); setCur(0); setPlaying(true); loadNcm(list[i]);
                return { list: list, idx: i };
              });
            }).catch(function(){});
        } else if (window.__lsRoomShare) window.__lsRoomShare('ai');
      }
    } catch (e) {}
  };

  // 打开真实歌详情抽屉（其它文件调用）
  window.__lsOpenNcmSong = (song) => { if (song) setNcmDrawerSong(song); };
  // 把 songs 追加到当前队列末尾（不打断当前播放）
  window.__lsQueueAppend = (songs) => {
    var add = (songs && songs.length) ? songs : (songs ? [songs] : []);
    if (!add.length) return;
    window.__lsPrefetch = null; window.__lsShufflePlan = [];
    setNcmQueue(q => { var list = q ? [...q.list, ...add] : add; if (window.__lsAdv) { window.__lsAdv.list = list; window.__lsAdv.kind = ''; } return q ? { ...q, list: list, kind: '' } : { list: add, idx: 0, kind: '' }; });
  };
  // 队列弹窗用：替换真实队列，但不主动改播放进度/播放状态。
  window.__lsReplaceQueue = (songs, idx0) => {
    var lst = Array.isArray(songs) ? songs.filter(Boolean) : (songs ? [songs] : []);
    if (!lst.length) { setNcmQueue(null); return; }
    var i = Math.max(0, Math.min(lst.length - 1, idx0 || 0));
    window.__lsPrefetch = null; window.__lsShufflePlan = []; lsSetAdv(lst, i, '');
    setNcmQueue({ list: lst, idx: i });
    setNcmSong(lst[i]);
  };

  // 播放模拟
  aUseEffect(() => { if (ncmSong) return; var s = LS_SONGS[idx]; var src = (s && s.src) || ''; if (src && lsAudioEl.src !== src) lsAudioEl.src = src; }, [idx, ncmSong]);
  // 暴露"当前在放的歌"给 AI 桥（claude-bridge 读 window.__lsNowPlaying 拼进提示词）
  aUseEffect(() => {
    var cur = (ncmQueue && ncmQueue.list && ncmQueue.list.length) ? ncmQueue.list[ncmQueue.idx] : (ncmSong || LS_SONGS[idx]);
    window.__lsNowPlaying = (cur && cur.title) ? { title: cur.title, artist: cur.artist || '', id: cur.id || '' } : null;
  }, [ncmSong, ncmQueue, idx]);
  aUseEffect(() => { if (playing) { try { const p = lsAudioEl.play(); if (p && p.catch) p.catch(function(){}); } catch(e){} } else lsAudioEl.pause(); }, [playing, idx, ncmSong, ncmQueue]);
  window.__lsEv = { playMode: playMode, ncmQueue: ncmQueue, playNcmIdx: playNcmIdx, loadNcm: loadNcm, requestFmMore: requestFmMore };
  window.__lsAdv.mode = playMode;
  window.__lsPlaying = playing;
  aUseEffect(() => {
    var onT = function(){ setCur(Math.floor(lsAudioEl.currentTime || 0)); };
    var onE = function(){
      // 后台续播关键：完全从模块游标 __lsAdv 同步推进，绝不经 React 决策（后台 React 不提交）
      var A = window.__lsAdv;
      if (A && A.list && A.list.length) {
        if (A.mode === 'one') { try { lsAudioEl.currentTime = 0; lsAudioEl.play().catch(function(){}); } catch(er){} return; }
        var n = A.list.length, ni;
        if (A.kind === 'fm') { ni = A.idx + 1; if (ni >= n) { try { (window.__lsEv && window.__lsEv.requestFmMore || function(){})({ playAfterAppend: true }); } catch(e){} return; } }
        else if (A.mode === 'shuffle') { ni = (A.plan && A.plan.length) ? A.plan.shift() : Math.floor(Math.random()*n); }
        else { ni = (A.idx + 1) % n; }
        A.idx = ni;
        var song = A.list[ni];
        loadNcm(song);
        try { setNcmSong(song); setCur(0); setPlaying(true); setNcmQueue(function(q){ return q ? { ...q, idx: ni } : q; }); } catch(e){}
        return;
      }
      var e = window.__lsEv || {};
      if (!LS_SONGS.length) { setPlaying(false); setCur(0); return; }
      setIdx(function(i){ return (e.playMode) === 'shuffle' ? Math.floor(Math.random()*LS_SONGS.length) : (i+1)%LS_SONGS.length; }); setCur(0);
    };
    var onP = function(){
      // 换源/自然 ended 会带一个 pause 事件——那不是用户/系统暂停，不能打断播放态（否则刚切的下一首被停）
      if (Date.now() - (window.__lsInternalLoad || 0) < 3500) return;
      if (lsAudioEl.ended) return;
      // React 认为在播、audio 却停了 = 系统中断（iOS 锁屏/来电/其它 app 抢占）：本地跟随，但标记来源，广播时跳过
      if (!window.__lsPlaying) return;
      window.__lsSysPause = Date.now(); window.__lsSysEvt = Date.now();
      setPlaying(false);
    };
    var onPl = function(){ if (!window.__lsPlaying) { window.__lsSysEvt = Date.now(); setPlaying(true); } };
    var onErr = function(){
      // 播放地址失效（网易云 URL 过期）：重取当前歌地址、回到原进度续播
      try {
        var e2 = window.__lsEv || {};
        var s2 = (e2.ncmQueue && e2.ncmQueue.list && e2.ncmQueue.list.length) ? e2.ncmQueue.list[e2.ncmQueue.idx] : null;
        if (!s2 || !s2.id) return;
        var at = lsAudioEl.currentTime || 0;
        var base2 = window.__LS_API || '/api';
        fetch(base2 + '/ncm/song-url?id=' + s2.id).then(function(r){ return r.json(); }).then(function(d){
          if (d && d.url) { lsAudioEl.src = d.url; try { lsAudioEl.currentTime = at; } catch(er){} if (window.__lsPlaying) lsAudioEl.play().catch(function(){}); }
        }).catch(function(){});
      } catch(er){}
    };
    var onVis = function(){ if (document.visibilityState === 'visible' && window.__lsPlaying && lsAudioEl.paused) { window.__lsSysEvt = Date.now(); lsAudioEl.play().catch(function(){}); } };
    lsAudioEl.addEventListener('timeupdate', onT); lsAudioEl.addEventListener('ended', onE);
    lsAudioEl.addEventListener('pause', onP); lsAudioEl.addEventListener('playing', onPl); lsAudioEl.addEventListener('error', onErr); lsAudioEl.addEventListener('stalled', onErr);
    document.addEventListener('visibilitychange', onVis);
    return function(){ lsAudioEl.removeEventListener('timeupdate', onT); lsAudioEl.removeEventListener('ended', onE); lsAudioEl.removeEventListener('pause', onP); lsAudioEl.removeEventListener('playing', onPl); lsAudioEl.removeEventListener('error', onErr); lsAudioEl.removeEventListener('stalled', onErr); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  // rAF □□: □□□□□□□ audio □□□□□ cur□□□ timeupdate □□□□□□□□□□
  aUseEffect(function(){
    if (!playing) return;
    var raf, last = -1;
    var tick = function(){ if (!lsAudioEl.paused) { var s = Math.floor(lsAudioEl.currentTime || 0); if (s !== last) { last = s; setCur(s); } } raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return function(){ if (raf) cancelAnimationFrame(raf); };
  }, [playing]);

  // 记住上次播放：mount 恢复（暂停态，不自动播，等用户点播放）
  aUseEffect(() => {
    try {
      var raw = localStorage.getItem('ls-lastplay'); if (!raw) return;
      var lp = JSON.parse(raw);
      if (lp && lp.list && lp.list.length) {
        var i = Math.max(0, Math.min(lp.list.length - 1, lp.idx || 0));
        setNcmQueue({ list: lp.list, idx: i, kind: lp.kind || '' });
        setNcmSong(lp.list[i]); setCur(lp.cur || 0); setPlaying(false);
        var base = window.__LS_API || '/api';
        if (lp.list[i].url) { lsAudioEl.src = lp.list[i].url; if (lp.cur) { try { lsAudioEl.currentTime = lp.cur; } catch(e){} } return; }
        fetch(base + '/ncm/lyric?id=' + lp.list[i].id).then(function(r){ return r.json(); }).then(function(l){ { window.__lsTLyric = (l && l.tlyric) || ''; setNcmLyric((l && l.lyric) || ''); }; }).catch(function(){});
        fetch(base + '/ncm/song-url?id=' + lp.list[i].id)
          .then(function(r){ return r.json(); })
          .then(function(d){ if (d && d.url) { lsAudioEl.src = d.url; if (lp.cur) { var sk = function(){ try { lsAudioEl.currentTime = lp.cur; } catch(e){} if (Math.abs((lsAudioEl.currentTime||0) - lp.cur) < 1.5) { lsAudioEl.removeEventListener('loadedmetadata', sk); lsAudioEl.removeEventListener('canplay', sk); } }; lsAudioEl.addEventListener('loadedmetadata', sk); lsAudioEl.addEventListener('canplay', sk); try { lsAudioEl.load(); } catch(e){} } } })
          .catch(function(){});
      }
    } catch (e) {}
  }, []);
  // 记住上次播放：队列变化即存 + 每 5s 存进度
  aUseEffect(() => {
    if (!ncmQueue || !ncmQueue.list || !ncmQueue.list.length) return;
    var save = function(){ try { localStorage.setItem('ls-lastplay', JSON.stringify({ list: ncmQueue.list, idx: ncmQueue.idx, kind: ncmQueue.kind || '', cur: Math.floor(lsAudioEl.currentTime || 0) })); } catch (e) {} };
    save();
    var t = setInterval(save, 5000);
    return function(){ clearInterval(t); };
  }, [ncmQueue]);

  aUseEffect(() => {
    window.__lsApplyRemote = function(m){
      // 远端同步来的状态：记录来源，让广播 effect 据此跳过回声（不再依赖 250ms 计时窗口）
      window.__lsLastRemote = { action: m.action, idx: (m.idx != null ? m.idx : null) };
      window.__lsRemoteEvt = Date.now(); // 状态卡片门控：远程同步来的变化不是本人的操作，不发卡
      if (m.idx != null) setIdx(m.idx);
      if (m.action === 'play') setPlaying(true);
      else if (m.action === 'pause') setPlaying(false);
      if (m.action === 'seek' && m.val != null) { try { lsAudioEl.currentTime = m.val; } catch(e){} }
    };
  }, []);
  aUseEffect(() => {
    // 首次挂载不广播：避免把初始 pause 态推给整个房间、误停别的设备
    if (!window.__lsBcastReady) { window.__lsBcastReady = true; return; }
    // 刚从远端同步过来的状态，不再原样广播回去（消除双端回声）
    var lr = window.__lsLastRemote;
    if (lr && lr.action === (playing ? 'play' : 'pause') && (lr.idx == null || lr.idx === idx)) { window.__lsLastRemote = null; return; }
    // 系统中断（锁屏/来电）导致的暂停不外发——只有本人/AI 主动操作才同步给对方
    if (!playing && (Date.now() - (window.__lsSysPause || 0) < 1500)) return;
    if (window.__LS_SYNC && window.__LS_SYNC.send) window.__LS_SYNC.send({ action: playing ? 'play' : 'pause', idx: idx, time: lsAudioEl.currentTime || 0 });
  }, [playing, idx]);
  // MediaSession（灵动岛/锁屏/系统媒体控制）——显示封面·歌名·歌手，非网页链接
  aUseEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    var ms = navigator.mediaSession;
    var song = ncmSong || LS_SONGS[idx] || window.LS_EMPTY_SONG;
    if (song && typeof MediaMetadata !== 'undefined') {
      try {
        var cov = String((song && song.cover) || '');
        var isUrl = /^(https?:|blob:|data:|\/)/.test(cov);
        ms.metadata = new MediaMetadata({
          title: song.title || '',
          artist: song.artist || '',
          album: song.album || '一起听',
          artwork: isUrl ? [{ src: cov + (cov.indexOf('music.126.net') >= 0 ? ((cov.indexOf('?') >= 0 ? '&' : '?') + 'param=512y512') : ''), sizes: '512x512', type: 'image/jpeg' }] : [],
        });
      } catch (e) {}
    }
    try { ms.playbackState = playing ? 'playing' : 'paused'; } catch (e) {}
    var H = function (name, fn) { try { ms.setActionHandler(name, fn); } catch (e) {} };
    H('play', function () { setPlaying(true); });
    H('pause', function () { if (document.visibilityState !== 'visible') window.__lsSysPause = Date.now(); setPlaying(false); });
    H('nexttrack', function () { if (ncmQueue) playNcmIdx(ncmQueue.idx + 1); else if (LS_SONGS.length) { setIdx(function (i) { return (i + 1) % LS_SONGS.length; }); setCur(0); } });
    H('previoustrack', function () { if (ncmQueue) playNcmIdx(ncmQueue.idx - 1); else if (LS_SONGS.length) { setIdx(function (i) { return (i - 1 + LS_SONGS.length) % LS_SONGS.length; }); setCur(0); } });
    H('seekto', function (d) { try { if (d && d.seekTime != null) { lsAudioEl.currentTime = d.seekTime; setCur(Math.floor(d.seekTime)); } } catch (e) {} });
  }, [ncmSong, playing, idx, ncmQueue]);
  const skinObj = LS_SKINS.find(s => s.id === skin) || LS_SKINS[0];
  const titles = { player: '此刻', playlist: '歌单', browse: '曲库', together: '一起听' };
  const kickers = { player: '正在一起听', playlist: '资料 · 歌单', browse: '搜索 · 日推 · 私人FM', together: '听歌档案 · 歌库 · 设置' };

  return (
    <div className={'ls-app ls-skin-' + skin + (wallOn ? ' has-wall' : '') + (wallOn && (wallBlur || 0) <= 0 ? ' no-blur' : '')} style={{ '--ls-wall-veil': wallVeil, '--ls-wall-blur': wallBlur + 'px', '--ls-card-veil': cardVeil, '--ls-card-blur': cardBlur, '--ls-nav-a': navVeil, '--ls-nav-blur': navBlur + 'px', ...(skin === 'custom' ? Object.assign({ '--ls-bg': customAc, '--ls-amb': customAc }, customVars.accent ? { '--ls-gold': customVars.accent, '--ls-eve': customVars.accent } : {}, customVars.panel ? { '--ls-panel': customVars.panel, '--ls-panel2': customVars.panel } : {}, customVars.ink ? { '--ls-ink': customVars.ink } : {}, customVars.line ? { '--ls-line': customVars.line, '--ls-line-soft': customVars.line } : {}, customVars.lyric ? { '--ls-lyric-dim': customVars.lyric } : {}) : {}), ...(darkMode ? { '--ls-bg': '#17171b', '--ls-bg2': '#1f1f25', '--ls-panel': '#26262e', '--ls-panel2': '#2e2e37', '--ls-ink': '#f0eef2', '--ls-ink-dim': '#b0aab8', '--ls-ink-faint': '#7a7585', '--ls-line': '#3a3a44', '--ls-line-soft': '#33333c', '--ls-amb': '#17171b', '--ls-shadow': 'rgba(0,0,0,.5)' } : {}) }}>
      <div className="ls-wall"><image-slot id="ls-wallpaper" shape="rect" cap="3000" placeholder="拖入你们的背景"></image-slot></div>
      <div className="ls-grain"></div>
      <div className="ls-col">
        {/* 顶栏 */}
        <div className="ls-top">
          <div className="ls-top-title">
            <div className="ls-top-kicker">{kickers[view]}</div>
            <div className="ls-top-h">{titles[view]}</div>
          </div>
          <button className="ls-skinbtn" onClick={() => setSkinOpen(true)}>
            <span className="sw"></span>{skinObj.name}
          </button>
        </div>

        {/* 视图 */}
        {view === 'player' && (
          <LSPlayerView {...{ idx, setIdx, playing, setPlaying, cur, setCur, loved, setLoved, coverMode, setCoverMode, playMode, cyclePlayMode, ncmSong, ncmLyric, ncmQueue, playNcmIdx }}
            onOpenDrawer={(i) => { if (ncmSong) setNcmDrawerSong(ncmSong); else if (LS_SONGS[i]) setDrawerIdx(i); }}
            onPickLyric={(line) => setAsk({ song: LS_SONGS[idx] || window.LS_EMPTY_SONG, passage: line })}
            onOpenQueue={() => setQueueOpen(true)}
            onOpenComments={(s) => setCommentsSong(s)}
            onEnterRoom={() => setRoomOpen(true)} />
        )}
        {view === 'playlist' && <LSPlaylistView onPlay={playSong} onOpenSong={(s) => setNcmDrawerSong(s)} openPl={openPl} setOpenPl={setOpenPl} wallOn={wallOn} setWallOn={setWallOn} wallVeil={wallVeil} setWallVeil={setWallVeil} wallBlur={wallBlur} setWallBlur={setWallBlur} cardVeil={cardVeil} setCardVeil={setCardVeil} cardBlur={cardBlur} setCardBlur={setCardBlur} navVeil={navVeil} setNavVeil={setNavVeil} navBlur={navBlur} setNavBlur={setNavBlur} skin={skin} setSkin={setSkin} customAc={customAc} setCustomAc={setCustomAc} customVars={customVars} setCustomVars={setCustomVars} darkMode={darkMode} setDarkMode={setDarkMode} />}
        {view === 'browse' && <LSBrowseView onPlay={playSong} onOpenSong={(s) => setNcmDrawerSong(s)} onOpenFM={() => setFmOpen(true)} />}
        {view === 'together' && (
          <div className="ls-together">
            <div className="ls-seg ls-tog-seg">
              {[['archive', '听歌档案'], ['model', '模型设置']].map(([k, l]) => (
                <button key={k} className={togetherTab === k ? 'on' : ''} onClick={() => setTogetherTab(k)}>{l}</button>
              ))}
            </div>
            {togetherTab === 'archive' && <LSArchiveView onOpenSong={openSongById} />}
            {togetherTab === 'model' && <LSModelInline bump={bump} />}
          </div>
        )}

        {/* 底栏 */}
        <div className="ls-nav">
          <button className={view === 'player' ? 'on' : ''} onClick={() => setView('player')}>
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>
            <span className="lb">此刻</span>
          </button>
          <button className={view === 'playlist' ? 'on' : ''} onClick={() => setView('playlist')}>
            <svg viewBox="0 0 24 24"><path d="M4 6h11M4 12h11M4 18h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><circle cx="18" cy="16" r="3"/><path d="M21 16V7l-3 1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <span className="lb">歌单</span>
          </button>
          <button className={view === 'browse' ? 'on' : ''} onClick={() => setView('browse')}>
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M21 21l-4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
            <span className="lb">曲库</span>
          </button>
          <button className={view === 'together' ? 'on' : ''} onClick={() => setView('together')}>
            <svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.2C.4 8.6 2 5 5.4 5c2 0 3.3 1.1 4.1 2.3C10.3 6.1 11.6 5 13.6 5 17 5 18.6 8.6 17 11.8 14.5 16.4 12 21 12 21z"/></svg>
            <span className="lb">一起听</span>
          </button>
        </div>
      </div>

      {/* A 详情抽屉 */}
      {drawerIdx !== null && (
        <LSSongDrawer song={LS_SONGS[drawerIdx]} ncmId={ncmSong && ncmSong.id} loved={loved} onToggleLove={() => setLoved(l => !l)}
          inLibrary={libHas(LS_SONGS[drawerIdx].id)} onAddLibrary={() => addToLib(LS_SONGS[drawerIdx])}
          onAskAI={(s, line) => { setDrawerIdx(null); setAsk({ song: s, passage: line || s.tag }); }}
          onClose={() => setDrawerIdx(null)} />
      )}
      {/* A' 真实歌详情抽屉（网易云等真实歌，features 用 ncmSong 显示） */}
      {ncmDrawerSong && (
        <LSSongDrawer song={ncmDrawerSong} ncmSong={ncmDrawerSong} ncmId={ncmDrawerSong.id} loved={loved} onToggleLove={() => setLoved(l => !l)}
          inLibrary={libHas(ncmDrawerSong.id)} onAddLibrary={() => addToLib(ncmDrawerSong)}
          onAskAI={(sg, line) => { setNcmDrawerSong(null); setAsk({ song: sg, passage: line || (sg && sg.tag) || (sg && sg.title) }); }}
          onClose={() => setNcmDrawerSong(null)} />
      )}
      {/* B 问 Ta */}
      {ask && <LSAskBar song={ask.song} passage={ask.passage} onClear={() => { setAsk(null); bump(); }} onSaved={bump} />}
      {/* 队列 */}
      {queueOpen && <LSQueueSheet idx={idx} setIdx={(i) => { setIdx(i); setCur(0); setPlaying(true); }} ncmQueue={ncmQueue} playNcmIdx={playNcmIdx} playMode={playMode} cyclePlayMode={cyclePlayMode} onClose={() => setQueueOpen(false)} />}
      {/* 评论 · 全屏 */}
      {commentsSong && <LSCommentsFull song={commentsSong} onClose={() => setCommentsSong(null)} />}
      {savePickerSong && <LSSavePicker song={savePickerSong} onClose={() => setSavePickerSong(null)} />}
      {/* 私人 FM 抽屉 */}
      {fmOpen && (
        <div className="ls-sheet-mask" onClick={() => setFmOpen(false)}>
          <div className="ls-fm-sheet" onClick={e => e.stopPropagation()}>
            <div className="ls-queue-grip"></div>
            <LSFMView onOpenSong={(it) => {}} bump={bump} />
          </div>
        </div>
      )}
      {/* E 模型设置弹层（保留，供其它入口）*/}
      {roomOpen && (
        <div className="ls-room-mask" onClick={() => setRoomOpen(false)}>
          <div className="ls-room-wrap" onClick={e => e.stopPropagation()}>
            {/* 房间背景：弹层最底层，铺到顶栏后面（顶栏磨砂才有内容可磨）；显隐由房间设置的开关控制 */}
            <div className="ls-room-wallbg" aria-hidden="true" style={{ display: 'none' }}><image-slot id="ls-room-bg" cap="3000" shape="rect" placeholder=""></image-slot></div>
            <div className="ls-room-head">
              <button className="ls-room-back" onClick={() => setRoomOpen(false)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
              <div className="ls-room-title">{(window.LS_PEOPLE && window.LS_PEOPLE.yu && window.LS_PEOPLE.yu.name) || 'AI'}</div>
              <button className="ls-room-gear" onClick={() => { if (window.__lsOpenRoomSet) window.__lsOpenRoomSet(); }} aria-label="房间设置"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg></button>
            </div>
            <LSChatView tab={roomTab} setTab={setRoomTab} idx={idx} setIdx={setIdx} playing={playing} setPlaying={setPlaying} ncmSong={ncmSong} ncmQueue={ncmQueue} playNcmIdx={playNcmIdx} cyclePlayMode={cyclePlayMode} playMode={playMode} loved={loved} setLoved={setLoved} cur={cur} addToLib={addToLib} ncmLyric={ncmLyric} />
          </div>
        </div>
      )}

      {/* 换肤 */}
      {skinOpen && (
        <div className="ls-skinsheet-mask" onClick={() => setSkinOpen(false)}>
          <div className="ls-skinsheet" onClick={e => e.stopPropagation()}>
            <h3>换一种光</h3>
            <div className="sub">Four moods · same us</div>
            <div className="ls-skingrid">
              {LS_SKINS.map(s => (
                <button key={s.id} className={'ls-skincard' + (s.id === skin ? ' on' : '')} onClick={() => { setSkin(s.id); setSkinOpen(false); }}>
                  <div className="sw" style={{ background: s.bg }}><i style={{ background: s.ac }}></i></div>
                  <div className="nm"><b>{s.name}</b><i>{s.po}</i></div>
                </button>
              ))}
            </div>
            <div className="ls-wall-row">
              <div className="ls-wall-prev"><image-slot id="ls-wallpaper" shape="rounded" radius="12" cap="3000" placeholder="拖图"></image-slot></div>
              <div className="tx"><b>自定义背景</b><i>拖一张你们的照片当壁纸</i></div>
              <button className={'ls-wall-tg' + (wallOn ? ' on' : '')} onClick={() => setWallOn(v => !v)}></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('ls-root')).render(<LSApp />);
