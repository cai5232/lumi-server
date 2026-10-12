/* listen/views.jsx — 播放器视图 · 点歌聊/评论视图 · 小组件画廊。 */

const { useState: vUseState, useEffect: vUseEffect, useRef: vUseRef, useLayoutEffect: vUseLayoutEffect } = React;

// ════════════ 播放器视图 ════════════
// LRC 字符串 → [{t:秒, line}]
function lsParseLRC(lrc) {
  if (!lrc) return [];
  const out = [];
  const re = /\[(\d+):(\d+)(?:[.:](\d+))?\](.*)/;
  String(lrc).split('\n').forEach((raw) => {
    const m = re.exec(raw);
    if (!m) return;
    const line = (m[4] || '').trim();
    if (!line) return;
    out.push({ t: parseInt(m[1], 10) * 60 + parseInt(m[2], 10), line: line });
  });
  return out;
}

// pane 0 = 封面页（黑胶/卡片可切）, pane 1 = 纯歌词页；左右滑动切换。
// coverMode: 'vinyl' | 'card'；playMode: 'loop' | 'one' | 'shuffle'
function LSPlayerView({ idx, setIdx, playing, setPlaying, cur, setCur, loved, setLoved,
  coverMode, setCoverMode, playMode, cyclePlayMode, onOpenDrawer, onPickLyric, onOpenQueue, onOpenComments, onEnterRoom, ncmSong, ncmLyric, ncmQueue, playNcmIdx, onPrev, onNext }) {
  const song = ((ncmQueue && ncmQueue.list && ncmQueue.list.length) ? ncmQueue.list[ncmQueue.idx] : (ncmSong || LS_SONGS[idx])) || window.LS_EMPTY_SONG;
  const goPrev = onPrev || ((ncmQueue && playNcmIdx) ? () => playNcmIdx(ncmQueue.idx - 1) : null);
  const goNext = onNext || ((ncmQueue && playNcmIdx) ? () => playNcmIdx(ncmQueue.idx + 1) : null);
  const lyrics = ncmSong ? lsParseLRC(ncmLyric) : ((song && song.lyrics) || []);
  const base = window.__LS_API || '/api';
  const n = LS_SONGS.length;
  const rel = (d) => n ? ((idx + d) % n + n) % n : 0;
  const dur = (song && song.dur) || 0;
  const [pane, setPane] = vUseState(0);
  const drag = vUseRef({ x: 0, on: false, moved: 0 });
  const lyBox = vUseRef(null), lyOn = vUseRef(null), lyHold = vUseRef(0), lyAuto = vUseRef(false);
  const [selIdx, setSelIdx] = vUseState(null);
  const selIdxRef = vUseRef(null);
  const [sliding, setSliding] = vUseState(false);
  const slideTimer = vUseRef(null);
  const snapTimer = vUseRef(null);
  const [cmtCount, setCmtCount] = vUseState(0);
  // 初始/换歌时查"我喜欢的音乐"真实红心状态（仅真实数字id）
  vUseEffect(() => {
    if (!song || !song.id || !/^\d+$/.test(String(song.id))) { setCmtCount(0); return; }
    let alive = true;
    fetch(base + '/ncm/likelist').then(function (r) { return r.json(); }).then(function (d) {
      if (!alive || !d || !d.ids) return;
      setLoved(d.ids.some(function (x) { return String(x) === String(song.id); }));
    }).catch(function () {});
    fetch(base + '/ncm/comments?id=' + song.id).then(function (r) { return r.json(); }).then(function (d) { if (alive && d) setCmtCount(d.total || 0); }).catch(function () {});
    return function () { alive = false; };
  }, [song && song.id]);
  const [toast, setToast] = vUseState('');
  const flash = (t) => { setToast(t); setTimeout(() => setToast(''), 1800); };
  const lyLp = vUseRef({ t: 0, fired: false });
  const lyLpStart = (line) => () => { lyLp.current.fired = false; clearTimeout(lyLp.current.t); if (!line || /^[^:：]{1,12}[:：]/.test(line.trim())) return; lyLp.current.t = setTimeout(() => { lyLp.current.fired = true; try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} window.__lsPendingQuote = { line: line, song: song.title || '' }; flash('已引用 · 去房间发给 TA'); }, 550); };
  const lyLpEnd = () => { clearTimeout(lyLp.current.t); };

  // 歌手主页：点歌手名 → 搜歌手 → 热门歌曲抽屉（点歌即播）
  const [artistSheet, setArtistSheet] = vUseState(null);
  const openArtist = (name) => {
    const nm = String(name || '').split('/')[0].trim();
    if (!nm) return;
    setArtistSheet({ name: nm, songs: null });
    fetch(base + '/ncm/search-artist?kw=' + encodeURIComponent(nm)).then(r => r.json()).then(d => {
      const a = d && d.artists && d.artists[0];
      if (!a) { setArtistSheet(s => (s && s.name === nm) ? { ...s, songs: [] } : s); return null; }
      setArtistSheet(s => (s && s.name === nm) ? { ...s, id: a.id, cover: a.cover, realName: a.name } : s);
      return fetch(base + '/ncm/artist-songs?id=' + a.id).then(r => r.json()).then(d2 => {
        setArtistSheet(s => (s && s.name === nm) ? { ...s, songs: (d2 && d2.songs) || [] } : s);
      });
    }).catch(() => setArtistSheet(s => (s && s.name === nm) ? { ...s, songs: [] } : s));
  };

  // more 更多：歌词字体/字号（存 localStorage，真作用到歌词区）+ 定时关闭
  const [lyMenu, setLyMenu] = vUseState(false);
  // 外语歌译文：网易云 tlyric 存 window.__lsTLyric（随 ncmLyric 一起更新），右下角"译"开关
  const [transOn, setTransOn] = vUseState(() => { try { return localStorage.getItem('ls-lyric-trans') !== '0'; } catch (e) { return true; } });
  const toggleTrans = () => setTransOn(v => { const nv = !v; try { localStorage.setItem('ls-lyric-trans', nv ? '1' : '0'); } catch (e) {} return nv; });
  const trMap = (() => {
    if (!ncmSong) return null;
    const t = lsParseLRC(window.__lsTLyric || '');
    if (!t.length) return null;
    const m = {}; t.forEach(x => { m[x.t] = x.line; });
    return m;
  })();
  const [lyFont, setLyFont] = vUseState(() => { try { return localStorage.getItem('ls-lyricfont') || 'serif'; } catch (e) { return 'serif'; } });
  const [lySize, setLySize] = vUseState(() => { try { return localStorage.getItem('ls-lyricsize') || 'm'; } catch (e) { return 'm'; } });
  const pickFont = (k) => { setLyFont(k); try { localStorage.setItem('ls-lyricfont', k); } catch (e) {} };
  const pickSize = (k) => { setLySize(k); try { localStorage.setItem('ls-lyricsize', k); } catch (e) {} };
  const [sleep, setSleep] = vUseState({ mode: 'off', until: 0 });
  const sleepTimer = vUseRef(null);
  const setSleepMode = (k) => {
    if (sleepTimer.current) { clearTimeout(sleepTimer.current); sleepTimer.current = null; }
    if (k === 'off') { setSleep({ mode: 'off', until: 0 }); return; }
    if (k === 'eot') { setSleep({ mode: 'eot', until: 0 }); return; }
    const until = Date.now() + k * 60000;
    setSleep({ mode: k, until: until });
    sleepTimer.current = setTimeout(() => { setPlaying(false); setSleep({ mode: 'off', until: 0 }); sleepTimer.current = null; }, k * 60000);
  };
  vUseEffect(() => () => { if (sleepTimer.current) clearTimeout(sleepTimer.current); }, []);
  // 播完这首：当前歌接近结束时暂停
  vUseEffect(() => {
    if (sleep.mode === 'eot' && song && song.dur && cur >= song.dur - 0.5) { setPlaying(false); setSleep({ mode: 'off', until: 0 }); }
  }, [cur, sleep.mode]);
  // 歌词字体/字号 + 面板样式（自包含注入，无需外部 CSS）
  vUseEffect(() => {
    if (document.getElementById('ls-lyricfont-style')) return;
    const st = document.createElement('style'); st.id = 'ls-lyricfont-style';
    st.textContent = [
      ".ls-cardlyric.lf-serif .cl,.ls-lyric-full.lf-serif .ls-lyric-line{font-family:var(--ls-serif-d)!important;font-style:italic}",
      ".ls-cardlyric.lf-song .cl,.ls-lyric-full.lf-song .ls-lyric-line{font-family:'Songti SC','STSong','Noto Serif SC','SimSun',serif!important;font-style:normal}",
      ".ls-cardlyric.lf-kai .cl,.ls-lyric-full.lf-kai .ls-lyric-line{font-family:'LXGW WenKai','Kaiti SC','STKaiti','KaiTi',serif!important;font-style:normal}",
      ".ls-cardlyric.lf-round .cl,.ls-lyric-full.lf-round .ls-lyric-line{font-family:'寒蝉全圆体','Yuanti SC','Yuanti','PingFang SC','HarmonyOS Sans SC',sans-serif!important;font-style:normal}",
      ".ls-cardlyric.lf-hand .cl,.ls-lyric-full.lf-hand .ls-lyric-line{font-family:var(--ls-hand)!important;font-style:normal}",
      ".ls-lyric-full.lz-s .ls-lyric-line{font-size:13px!important;font-weight:500}.ls-lyric-full.lz-s .ls-lyric-line.on{font-size:14px!important}",
      ".ls-lyric-full.lz-m .ls-lyric-line{font-size:15px!important;font-weight:500}.ls-lyric-full.lz-m .ls-lyric-line.on{font-size:16px!important}",
      ".ls-lyric-full.lz-l .ls-lyric-line{font-size:17px!important;font-weight:500}.ls-lyric-full.lz-l .ls-lyric-line.on{font-size:18px!important}",
      ".ls-lyric-full.lz-xl .ls-lyric-line{font-size:19px!important;font-weight:500}.ls-lyric-full.lz-xl .ls-lyric-line.on{font-size:20px!important}",
      ".ls-cardlyric.lz-s .cl{font-size:11.5px!important}.ls-cardlyric.lz-s .cl.on{font-size:12.5px!important}",
      ".ls-cardlyric.lz-m .cl{font-size:12.5px!important}.ls-cardlyric.lz-m .cl.on{font-size:13.5px!important}",
      ".ls-cardlyric.lz-l .cl{font-size:13.5px!important}.ls-cardlyric.lz-l .cl.on{font-size:15px!important}",
      ".ls-cardlyric.lz-xl .cl{font-size:15px!important}.ls-cardlyric.lz-xl .cl.on{font-size:16.5px!important}",
      ".ls-lyric-full{justify-content:flex-start!important;padding-top:34vh!important;padding-bottom:62vh!important;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}",
      ".ls-lyric-full .ls-lyric-line:hover:not(.on),.ls-lyric-full .ls-lyric-line:active:not(.on){color:var(--ls-ink-faint)!important}",
      ".ls-lyric-full .ls-lyric-line{position:relative}",
      ".ls-lysel-t{position:absolute;left:6px;top:50%;transform:translateY(-50%);font-family:var(--ls-meta);font-size:11px;color:var(--ls-ink-faint);opacity:.75;pointer-events:none;font-style:normal}",
      ".ls-lysel-play{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--ls-gold,#c8a45a);cursor:pointer;padding:0;z-index:2}",
      ".ls-lysel-play svg{fill:currentColor}",
      ".ls-lysel-line{position:absolute;left:44px;right:44px;top:50%;height:1px;background:linear-gradient(90deg,transparent,var(--ls-line,rgba(255,255,255,.16)) 25%,var(--ls-line,rgba(255,255,255,.16)) 75%,transparent);pointer-events:none;opacity:.7;z-index:1}",
      ".ls-lyric-area{position:relative}",
      ".ls-lyric-centerline{position:absolute;left:16px;right:16px;top:50%;height:1px;background:linear-gradient(90deg,transparent,var(--ls-line,rgba(255,255,255,.16)) 30%,var(--ls-line,rgba(255,255,255,.16)) 70%,transparent);pointer-events:none;z-index:1;opacity:.7}",
      ".ls-engage{position:relative}",
      ".ls-lymenu-mask{position:fixed;inset:0;z-index:60}",
      ".ls-lymenu{position:absolute;right:6px;bottom:100%;margin-bottom:10px;z-index:61;width:264px;max-width:calc(100vw - 32px);background:color-mix(in srgb, var(--ls-panel) 15%, #fff);border:1px solid var(--ls-line,rgba(255,255,255,.09));border-radius:16px;padding:14px 14px 12px;box-shadow:0 18px 50px rgba(0,0,0,.5)}",
      ".ls-lymenu .hd{display:flex;align-items:center;justify-content:space-between;font-family:var(--ls-meta);font-size:11px;color:var(--ls-ink-dim);margin:9px 2px 7px;letter-spacing:.04em}",
      ".ls-lymenu .hd:first-child{margin-top:0}",
      ".ls-lymenu .hd i{font-style:normal;font-size:10px;color:var(--ls-ink-faint);opacity:.85}",
      ".ls-lymenu .row{display:flex;flex-wrap:wrap;gap:6px}",
      ".ls-lymenu .row button{flex:1;min-width:42px;padding:7px 4px;border-radius:9px;background:color-mix(in srgb, var(--ls-bg) 18%, #fff);border:1px solid transparent;color:var(--ls-ink-dim);font-family:var(--ls-cn);font-size:13px;cursor:pointer;transition:.15s}",
      ".ls-lymenu .row button.on{background:var(--ls-gold,#c8a45a);color:#1a1712;border-color:var(--ls-gold,#c8a45a);font-weight:600}",
      ".ls-lymenu .det{width:100%;margin-top:12px;padding:10px;border-radius:10px;background:transparent;border:1px solid var(--ls-line,rgba(255,255,255,.12));color:var(--ls-ink);font-family:var(--ls-serif-d);font-style:italic;font-size:15px;cursor:pointer}"
    ].join('\n');
    document.head.appendChild(st);
  }, []);

  // 当前歌词行
  let li = 0;
  lyrics.forEach((l, i) => { if (cur >= l.t) li = i; });
  try { window.__lsCurLyric = (lyrics[li] && lyrics[li].line) || ''; } catch (e) {}
  const flowY = 60 - li * 38;

  // 歌词自动回滚：当前句滚到可视中间；用户手动滚动后暂停几秒
  vUseEffect(() => {
    if (pane !== 1) return;
    if (Date.now() < lyHold.current) return;
    const box = lyBox.current, on = lyOn.current;
    if (!box || !on) return;
    const br = box.getBoundingClientRect(), or = on.getBoundingClientRect();
    // 统一锚点：当前句常驻容器 30% 高度（偏上再高两行），选句横线/吸附也用同一锚点
    const target = box.scrollTop + (or.top - br.top) - box.clientHeight * 0.30 + or.height / 2;
    lyAuto.current = true;
    try { box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' }); } catch (e) { box.scrollTop = Math.max(0, target); }
    setTimeout(() => { lyAuto.current = false; }, 620);
  }, [li, pane]);
  const onLyScroll = () => {
    if (lyAuto.current) return;
    lyHold.current = Date.now() + 3000;
    const box = lyBox.current;
    if (box) {
      const br = box.getBoundingClientRect();
      const cy = br.top + box.clientHeight * 0.30;
      const rows = box.querySelectorAll('.ls-lyric-line');
      let best = -1, bd = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const rr = rows[i].getBoundingClientRect();
        const d = Math.abs(rr.top + rr.height / 2 - cy);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) { setSelIdx(best); selIdxRef.current = best; }
    }
    setSliding(true);
    if (slideTimer.current) clearTimeout(slideTimer.current);
    slideTimer.current = setTimeout(() => { setSliding(false); }, 1200);
    // 手松开后：把离中线最近的那句吸附到中线上，让句子对准三件套
    if (snapTimer.current) clearTimeout(snapTimer.current);
    snapTimer.current = setTimeout(() => {
      const box2 = lyBox.current; if (!box2) return;
      const rows = box2.querySelectorAll('.ls-lyric-line');
      const bi = selIdxRef.current;
      if (bi == null || !rows[bi]) return;
      const br2 = box2.getBoundingClientRect(), rr2 = rows[bi].getBoundingClientRect();
      const target2 = box2.scrollTop + (rr2.top - br2.top) - box2.clientHeight * 0.30 + rr2.height / 2;
      // 瞬时吸附：smooth 在 iOS 惯性滚动下会被打断，导致句子停不到中线上
      lyAuto.current = true;
      box2.scrollTop = Math.max(0, target2);
      setTimeout(() => { lyAuto.current = false; }, 120);
    }, 240);
  };
  vUseEffect(() => () => { if (slideTimer.current) clearTimeout(slideTimer.current); if (snapTimer.current) clearTimeout(snapTimer.current); }, []);
  // 进入纯歌词页 / 切歌：立刻把当前行(前奏时=第一句)滚到垂直居中，避免初始贴顶
  vUseLayoutEffect(() => {
    if (pane !== 1) return;
    lyHold.current = 0;
    const center = () => {
      const box = lyBox.current, on = lyOn.current;
      if (!box || !on) return;
      const br = box.getBoundingClientRect(), or = on.getBoundingClientRect();
      const target = box.scrollTop + (or.top - br.top) - box.clientHeight * 0.30 + or.height / 2;
      lyAuto.current = true;
      box.scrollTop = Math.max(0, target);
      setTimeout(() => { lyAuto.current = false; }, 80);
    };
    center();
    const r = requestAnimationFrame(center);
    return () => cancelAnimationFrame(r);
  }, [pane, song && song.id]);

  const pdrag = vUseRef(false);
  const seekTo = (clientX, track) => {
    const r = track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur;
    setCur(t); try { window.__lsAudioEl.currentTime = t; } catch (er) {}
  };
  const seek = (e) => seekTo(e.clientX, e.currentTarget);
  const progDown = (e) => { pdrag.current = true; seekTo(e.touches ? e.touches[0].clientX : e.clientX, e.currentTarget); };
  const progMove = (e) => { if (!pdrag.current) return; seekTo(e.touches ? e.touches[0].clientX : e.clientX, e.currentTarget); };
  const progUp = () => { pdrag.current = false; };
  const seekToLine = (t) => {
    setCur(t); try { window.__lsAudioEl.currentTime = t; } catch (er) {} setPlaying(true);
    // 点完播放立即收起三件套，并让自动滚动马上接管
    setSliding(false);
    if (slideTimer.current) clearTimeout(slideTimer.current);
    if (snapTimer.current) clearTimeout(snapTimer.current);
    lyHold.current = 0;
  };
  const pct = dur ? cur / dur * 100 : 0;

  // 滑动切换封面/歌词页
  const onDown = (e) => { drag.current = { x: (e.touches ? e.touches[0].clientX : e.clientX), y: (e.touches ? e.touches[0].clientY : e.clientY), on: true, moved: 0, my: 0 }; };
  const onMove = (e) => { if (!drag.current.on) return; drag.current.moved = (e.touches ? e.touches[0].clientX : e.clientX) - drag.current.x; drag.current.my = (e.touches ? e.touches[0].clientY : e.clientY) - drag.current.y; };
  const onUp = () => { const m = drag.current.moved, my = drag.current.my || 0; drag.current.on = false; if (Math.abs(m) <= Math.abs(my) + 8) return; if (m < -70 && pane === 1 && onEnterRoom) onEnterRoom(); else if (m < -50 && pane === 0) setPane(1); else if (m > 50 && pane === 1) setPane(0); };

  const cls = (d) => d === 0 ? 'c0' : d === -1 ? 'l1' : d === 1 ? 'r1' : d === -2 ? 'l2' : d === 2 ? 'r2' : 'hid';
  // 选句三件套的像素位置：对齐歌词滚动容器的 41% 锚点（挂在外层 area 上，需换算偏移）
  let selTop = null;
  if (sliding && lyBox.current && lyBox.current.parentNode) {
    const bx = lyBox.current, ar = bx.parentNode;
    const bo = bx.getBoundingClientRect(), ao = ar.getBoundingClientRect();
    selTop = Math.round((bo.top - ao.top) + bx.clientHeight * 0.30);
  }
  const selStyle = selTop != null ? { top: selTop + 'px' } : null;
  const playModeIcon = playMode === 'one' ? LSIcon.one : playMode === 'shuffle' ? LSIcon.shuffle : LSIcon.loop;
  const playModeName = playMode === 'one' ? '单曲循环' : playMode === 'shuffle' ? '随机播放' : '列表循环';

  return (
    <div className={'ls-body ls-player' + (pane === 1 ? ' lyric-mode' : '')}>
      {/* 双人头像 + 耳机线 + 距离（纯歌词页不显示）*/}
      {pane === 0 && (
      <div className="ls-np-bond">
        <div className="faces">
          <div className="face yu"><image-slot id={LS_PEOPLE.yu.slot} shape="circle" always-ctl tap-replace placeholder=""></image-slot></div>
          <svg className="cord" viewBox="0 0 120 40" preserveAspectRatio="none">
            <path d="M30 12 C 30 40, 90 40, 90 12" />
          </svg>
          <div className="face eve"><image-slot id={LS_PEOPLE.eve.slot} shape="circle" always-ctl tap-replace placeholder=""></image-slot></div>
        </div>
        <div className="dist">相距 <LSEdit eid="pf-dist" def={String(LS_STATS.distanceKm)}/> 公里，一起听了 <LSEdit eid="pf-hours" def={String(LS_STATS.togetherHours)}/> 小时 <LSEdit eid="pf-mins" def={String(LS_STATS.togetherMins)}/> 分钟</div>
      </div>
      )}

      {/* 中部可填充区（封面页 / 纯歌词页），左右滑动切换。高度固定，flex 填满 */}
      <div className="ls-mid" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
        onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}>

        {pane === 0 ? (
          <div className="ls-cover-area">
            {/* 封面：黑胶 / 卡片（下移，居中偏下）*/}
            <div className="ls-cover-hero">
              {coverMode === 'vinyl' ? (
                <div className="ls-vinyl-wrap" onClick={() => setCoverMode('card')}>
                  <div className={'ls-tonearm' + (playing ? ' on' : '')}>
                    <svg viewBox="0 0 120 120"><circle cx="92" cy="20" r="9" fill="currentColor" opacity=".25"/><circle cx="92" cy="20" r="5" fill="currentColor"/><path d="M92 22 L60 70" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><rect x="50" y="64" width="18" height="13" rx="3" transform="rotate(33 59 70)" fill="currentColor"/></svg>
                  </div>
                  <div className={'ls-vinyl' + (playing ? ' spin' : '')}>
                    <div className="grooves"></div>
                    <div className="label"><LSCover cover={song.cover} shape="circle" size={400} /></div>
                    <div className="hole"></div>
                  </div>
                </div>
              ) : (
                <div className="ls-cards">
                  {[-2, -1, 0, 1, 2].map(d => {
                    if (ncmQueue && ncmQueue.list && ncmQueue.list.length) {
                      const ql = ncmQueue.list, qn = ql.length;
                      const qi = ((ncmQueue.idx + d) % qn + qn) % qn;
                      const s = ql[qi];
                      return (
                        <div key={d} className={'ls-card ' + cls(d)} onClick={() => d === 0 ? setCoverMode('vinyl') : (playNcmIdx && playNcmIdx(ncmQueue.idx + d))}>
                          <LSCover cover={s.cover} shape="rounded" radius={14} size={300} />
                        </div>
                      );
                    }
                    const s = n ? LS_SONGS[rel(d)] : song;
                    return (
                      <div key={d} className={'ls-card ' + cls(d)} onClick={() => (d === 0 || !n) ? setCoverMode('vinyl') : setIdx(rel(d))}>
                        <LSCover cover={s.cover} size={360} shape="rounded" radius={14} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {/* 歌名 + 歌手 + 三行歌词（紧贴封面下方，行距更大）*/}
            <div className="ls-cover-meta">
              <div className="ls-nowtag" onClick={() => onOpenDrawer && onOpenDrawer(idx)}>
                <div className="t">{song.title}</div>
                <div className="a"><span className="art-link" onClick={(e) => { e.stopPropagation(); openArtist(song.artist); }}>{song.artist}</span> · {song.album} · 详情 ›</div>
              </div>
              <div className={'ls-cardlyric lf-' + lyFont + ' lz-' + lySize}>
                {[li - 1, li, li + 1].map((k) => {
                  const l = lyrics[k];
                  if (!l) return <div key={k} className="cl">&nbsp;</div>;
                  return <div key={k} className={'cl' + (k === li ? ' on' : '')}>{l.line}</div>;
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="ls-lyric-area">
            <div className="ls-lyric-top">
              <div className="t">{song.title}</div>
              <div className="a"><span className="art-link" onClick={(e) => { e.stopPropagation(); openArtist(song.artist); }}>{song.artist}</span> · {song.album}</div>
            </div>
            <div className={'ls-lyric-full lf-' + lyFont + ' lz-' + lySize} ref={lyBox} onScroll={onLyScroll}>
              {lyrics.map((l, i) => (
                <div key={i} ref={i === li ? lyOn : null} className={'ls-lyric-line' + (i === li ? ' on' : '')}
                  onClick={() => { if (lyLp.current.fired) { lyLp.current.fired = false; return; } if (onPickLyric && l.line && !/^[^:：]{1,12}[:：]/.test(l.line.trim())) onPickLyric(l.line); }}
                  onPointerDown={lyLpStart(l.line)} onPointerUp={lyLpEnd} onPointerLeave={lyLpEnd} onPointerMove={lyLpEnd}>
                  {l.line}
                  {transOn && trMap && trMap[l.t] ? <div className="lyr-tr">{trMap[l.t]}</div> : null}
                </div>
              ))}
            </div>

            {/* 滑动选句：三件套固定在 41% 锚点（与播放行常驻高度一致），松手后选中句吸附到线上 */}
            {sliding ? <div className="ls-lyric-centerline" style={selStyle}></div> : null}
            {sliding && selIdx != null && lyrics[selIdx] ? <span className="ls-lysel-t" style={selStyle}>{lsFmt(lyrics[selIdx].t)}</span> : null}
            {sliding && selIdx != null && lyrics[selIdx] ? <button className="ls-lysel-play" style={selStyle} onClick={(e) => { e.stopPropagation(); seekToLine(lyrics[selIdx].t); }}>{LSIcon.play({ width: 15, height: 15 })}</button> : null}
            <div className="ls-lyric-hint">点一句 · 引用给 AI</div>
          </div>
        )}

        {/* 歌手主页抽屉 */}
        {artistSheet && ReactDOM.createPortal((
          <div className="ls-sheet-mask" onClick={() => setArtistSheet(null)}>
            <div className="ls-artist-sheet" onClick={e => e.stopPropagation()}>
              <div className="ah">
                {artistSheet.cover ? <div className="av"><img src={window.lsCoverSize(artistSheet.cover, 120)} alt="" /></div> : null}
                <div className="an"><b>{artistSheet.realName || artistSheet.name}</b><i>热门歌曲</i></div>
                {artistSheet.songs && artistSheet.songs.length ? (
                  <div className="abtns">
                    <button className="abtn primary" onClick={() => { if (window.__lsPlayNcm) window.__lsPlayNcm(artistSheet.songs[0], artistSheet.songs, 0); setArtistSheet(null); }}>全部播放</button>
                    <button className="abtn" onClick={() => { if (window.__lsQueueAppend) window.__lsQueueAppend(artistSheet.songs); setArtistSheet(null); }}>加入列表</button>
                  </div>
                ) : null}
              </div>
              <div className="alist">
                {artistSheet.songs === null ? <div className="ae">加载中…</div> : artistSheet.songs.length ? artistSheet.songs.map((s2, i2) => (
                  <div key={s2.id} className="arow" onClick={() => { setArtistSheet(null); if (window.__lsOpenNcmSong) window.__lsOpenNcmSong(s2); }}>
                    <span className="no">{String(i2 + 1).padStart(2, '0')}</span>
                    <div className="cv"><LSCover cover={s2.cover} shape="rounded" radius={8} size={80} /></div>
                    <div className="si"><b>{s2.title}</b><i>{s2.album || s2.artist}</i></div>
                  </div>
                )) : <div className="ae">没有找到这位歌手的歌</div>}
              </div>
            </div>
          </div>
        ), document.body)}

        {/* 页指示点 */}
        <div className="ls-pane-dots">
          <span className={pane === 0 ? 'on' : ''} onClick={() => setPane(0)}></span>
          <span className={pane === 1 ? 'on' : ''} onClick={() => setPane(1)}></span>
        </div>
      </div>

      {/* 红心 · 下载 · 评论（全屏）· 更多（照原生那一排） */}
      <div className="ls-engage">
        <button className={'eb' + (loved ? ' on' : '')} onClick={() => {
          const willLove = !loved; setLoved(l => !l);
          if (song && song.id && /^\d+$/.test(String(song.id))) { try { fetch(base + '/ncm/like?id=' + song.id + '&like=' + (willLove ? 1 : 0), { method: 'POST' }).catch(function () {}); } catch (e) {} }
          if (willLove && song && song.id) { try { window.__lsActor = { who: 'user', t: Date.now() }; if (window.__lsRoomEvent && song.title) window.__lsRoomEvent('红心了《' + song.title + '》'); const st = window.__lsStore; if (st && st.library && !st.library.some(x => x.songId === song.id)) { st.library.unshift({ songId: song.id, title: song.title, artist: song.artist, cover: song.cover, pinned: false, notes: 0, last: Date.now() }); if (window.lsSaveStore) window.lsSaveStore(st); } flash('已收藏 · ' + song.title); } catch (e) {} }
        }}>
          <svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.2C.4 8.6 2 5 5.4 5c2 0 3.3 1.1 4.1 2.3C10.3 6.1 11.6 5 13.6 5 17 5 18.6 8.6 17 11.8 14.5 16.4 12 21 12 21z"/></svg>
        </button>
        <button className="eb" onClick={() => { if (song && song.id && /^\d+$/.test(String(song.id)) && window.__lsSavePicker) { window.__lsSavePicker(song); } else { flash('这首暂不能收藏'); } }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4h12a1 1 0 0 1 1 1v16l-7-4-7 4V5a1 1 0 0 1 1-1z"/></svg>
        </button>
        <button className="eb" onClick={() => onOpenComments && onOpenComments(song)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 5h16v11H9l-4 4z" strokeLinejoin="round"/></svg>
          <span>{cmtCount ? (cmtCount >= 10000 ? (cmtCount/10000).toFixed(cmtCount >= 100000 ? 0 : 1) + 'w' : cmtCount) : '评论'}</span>
        </button>
        {pane === 1 && trMap ? <button className={'eb trx' + (transOn ? ' ton' : '')} onClick={toggleTrans} title="译文开关"><span className="trt">译</span></button> : null}
        <button className={'eb' + (lyMenu ? ' on' : '')} onClick={() => setLyMenu(m => !m)}>
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
        </button>
        {lyMenu && (
          <>
            <div className="ls-lymenu-mask" onClick={() => setLyMenu(false)}></div>
            <div className="ls-lymenu" onClick={e => e.stopPropagation()}>
              <div className="hd">歌词字体<i>不跟随全局</i></div>
              <div className="row">
                {[['serif', '衬线'], ['song', '宋'], ['kai', '楷'], ['round', '圆体'], ['hand', '手写']].map(([k, l]) => (
                  <button key={k} className={lyFont === k ? 'on' : ''} onClick={() => pickFont(k)}>{l}</button>
                ))}
              </div>
              <div className="hd">歌词字号</div>
              <div className="row">
                {[['s', '小'], ['m', '中'], ['l', '大'], ['xl', '超大']].map(([k, l]) => (
                  <button key={k} className={lySize === k ? 'on' : ''} onClick={() => pickSize(k)}>{l}</button>
                ))}
              </div>
              <div className="hd">定时关闭{sleep.mode !== 'off' && sleep.mode !== 'eot' && sleep.until ? <i>剩 {Math.max(0, Math.ceil((sleep.until - Date.now()) / 60000))} 分</i> : null}</div>
              <div className="row">
                {[['off', '关'], [15, '15分'], [30, '30分'], [60, '60分'], [90, '90分'], ['eot', '播完这首']].map(([k, l]) => (
                  <button key={k} className={sleep.mode === k ? 'on' : ''} onClick={() => setSleepMode(k)}>{l}</button>
                ))}
              </div>
              <button className="det" onClick={() => { setLyMenu(false); onOpenDrawer && onOpenDrawer(idx); }}>歌曲详情 ›</button>
            </div>
          </>
        )}
      </div>

      {/* 进度（爱心滑块） */}
      <div className="ls-prog">
        <div className="ls-prog-track" onClick={seek} onMouseDown={progDown} onMouseMove={progMove} onMouseUp={progUp} onMouseLeave={progUp} onTouchStart={progDown} onTouchMove={progMove} onTouchEnd={progUp}>
          <div className="ls-prog-fill" style={{ width: pct + '%' }}></div>
          <div className="ls-prog-heart" style={{ left: pct + '%' }}>
            <svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.2C.4 8.6 2 5 5.4 5c2 0 3.3 1.1 4.1 2.3C10.3 6.1 11.6 5 13.6 5 17 5 18.6 8.6 17 11.8 14.5 16.4 12 21 12 21z"/></svg>
          </div>
        </div>
        <div className="ls-prog-time"><span>{lsFmt(cur)}</span><span>极高音质</span><span>{lsFmt(dur)}</span></div>
      </div>

      {/* 控制：播放方式 · 上一首 · 播放 · 下一首 · 队列 */}
      <div className="ls-ctrl">
        <button className="mini" onClick={() => { window.__lsActor = { who: 'user', t: Date.now() }; cyclePlayMode(); }} title={playModeName}>{playModeIcon()}</button>
        <button onClick={() => { window.__lsActor = { who: 'user', t: Date.now() }; if (ncmQueue && goPrev) { goPrev(); } else { setIdx(rel(-1)); setCur(0); } }}>{LSIcon.prev()}</button>
        <button className="play" onClick={() => { window.__lsActor = { who: 'user', t: Date.now() }; setPlaying(p => !p); }}>{playing ? LSIcon.pause() : LSIcon.play()}</button>
        <button onClick={() => { window.__lsActor = { who: 'user', t: Date.now() }; if (ncmQueue && goNext) { goNext(); } else { setIdx(rel(1)); setCur(0); } }}>{LSIcon.next()}</button>
        <button className="mini" onClick={onOpenQueue} title="播放队列">{LSIcon.queue()}</button>
      </div>

      {toast && <div className="ls-toast" style={{ position: 'fixed', left: '50%', bottom: '18%', transform: 'translateX(-50%)', zIndex: 9999, padding: '8px 16px', borderRadius: 20, background: 'var(--ls-panel)', border: '1px solid var(--ls-line-soft)', boxShadow: '0 8px 24px var(--ls-shadow)', fontFamily: 'var(--ls-cn)', fontSize: 12, color: 'var(--ls-ink)', whiteSpace: 'nowrap' }}>{toast}</div>}
    </div>
  );
}

// ── 播放队列抽屉（左下角按钮）· 仿原生 ──────────────────
function LSQueueSheet({ idx, setIdx, ncmQueue, playNcmIdx, playMode, cyclePlayMode, onClose }) {
  const real = !!(ncmQueue && ncmQueue.list && ncmQueue.list.length);
  const [tab, setTab] = vUseState('cur');
  const [list, setList] = vUseState(() => LS_SONGS.map((s, i) => i));
  const [toast, setToast] = vUseState('');
  const playModeIcon = playMode === 'one' ? LSIcon.one : playMode === 'shuffle' ? LSIcon.shuffle : LSIcon.loop;
  const playModeName = playMode === 'one' ? '单曲循环' : playMode === 'shuffle' ? '随机播放' : '列表循环';
  const stop = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } };
  const say = (msg) => {
    setToast(msg);
    clearTimeout(window.__lsQueueToastTimer);
    window.__lsQueueToastTimer = setTimeout(function () { setToast(''); }, 1600);
  };
  const currentSong = () => real ? ((ncmQueue.list && ncmQueue.list[ncmQueue.idx]) || ncmQueue.list[0]) : (LS_SONGS[idx] || window.LS_EMPTY_SONG);
  const removeAt = (e, songI) => { stop(e); setList(l => l.filter(x => x !== songI)); };
  const removeRealAt = (e, i) => {
    stop(e);
    if (!real || !window.__lsReplaceQueue) return;
    if (i === ncmQueue.idx) { say('正在播放的歌会保留'); return; }
    var nextList = ncmQueue.list.filter(function (_s, j) { return j !== i; });
    var nextIdx = i < ncmQueue.idx ? ncmQueue.idx - 1 : ncmQueue.idx;
    if (!nextList.length) { say('队列至少保留当前播放'); return; }
    window.__lsReplaceQueue(nextList, nextIdx);
    say('已从队列移除');
  };
  const clearQueue = (e) => {
    stop(e);
    if (real) {
      var curSong = currentSong();
      if (curSong && window.__lsReplaceQueue) {
        window.__lsReplaceQueue([curSong], 0);
        say('已清空待播，保留当前播放');
      }
      return;
    }
    setList([]);
    say('已清空队列');
  };
  const downloadCurrent = (e) => {
    stop(e);
    var song = currentSong();
    var el = window.__lsAudioEl || document.querySelector('audio');
    var url = (song && song.url) || (el && el.src) || '';
    if (!url) { say('当前歌曲暂无可下载地址'); return; }
    try {
      var a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.download = ((song && song.title) || 'song').replace(/[\\/:*?"<>|]+/g, '_') + '.mp3';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { document.body.removeChild(a); } catch (_e) {} }, 0);
      say('已打开下载');
    } catch (er) {
      try { window.open(url, '_blank'); } catch (_e) {}
      say('已打开下载');
    }
  };
  const saveQueue = (e) => {
    stop(e);
    var songs = real ? (ncmQueue.list || []) : list.map(function (songI) { return LS_SONGS[songI]; }).filter(Boolean);
    songs = songs.filter(function (s) { return s && s.id && /^\d+$/.test(String(s.id)); });
    if (songs.length && window.__lsSavePicker) {
      window.__lsSavePicker(songs);
      onClose();
      return;
    }
    say('当前列表没有可收藏到歌单的网易云歌曲');
  };
  return (
    <div className="ls-sheet-mask" onClick={onClose}>
      <div className="ls-queue" onClick={e => e.stopPropagation()}>
        <div className="ls-queue-grip"></div>
        {/* 顶部：当前播放 / 历史播放 */}
        <div className="ls-queue-tabs">
          <button className={tab === 'cur' ? 'on' : ''} onClick={(e) => { stop(e); setTab('cur'); }}>当前播放<sup>{real ? ncmQueue.list.length : list.length}</sup></button>
          <button className={tab === 'his' ? 'on' : ''} onClick={(e) => { stop(e); setTab('his'); }}>历史播放</button>
        </div>
        {/* 操作栏：播放方式 chip + 智能过渡 + 下载/收藏/清空 */}
        <div className="ls-queue-bar">
          <button className="chip" onClick={(e) => { stop(e); cyclePlayMode && cyclePlayMode(); }}>{playModeIcon()}<span>{playModeName}</span></button>
          <button className="chip" onClick={(e) => { stop(e); say('智能过渡已保持当前设置'); }}><span className="merge"></span>智能过渡</button>
          <div className="sp"></div>
          <button className="ic" title="下载" onClick={downloadCurrent}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M8 11l4 4 4-4M5 20h14"/></svg></button>
          <button className="ic" title="收藏整个播放列表" onClick={saveQueue}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 9v6M9 12h6"/></svg></button>
          <button className="ic" title="清空" onClick={clearQueue}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg></button>
        </div>
        {toast && <div className="ls-toast" style={{ position: 'absolute', left: '50%', bottom: 22, transform: 'translateX(-50%)', zIndex: 30, padding: '8px 16px', borderRadius: 20, background: 'rgba(40,36,42,.92)', color: '#fff', fontFamily: 'var(--ls-cn)', fontSize: 12, whiteSpace: 'nowrap' }}>{toast}</div>}
        <div className="ls-queue-auto"><span className="dot">✓</span>自动播放推荐歌曲</div>
        <div className="ls-queue-list">
          {real ? ncmQueue.list.map((s, i) => (
            <div key={(s.id || 's') + '_' + i} className={'ls-queue-item' + (i === ncmQueue.idx ? ' on' : '')} onClick={() => { playNcmIdx(i); onClose(); }}>
              <div className="cv" style={{ width: 44, height: 44, borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}><LSCover cover={s.cover} shape="rounded" radius={8} size={120} /></div>
              <div className="si">
                <b>{s.fee === 1 && <span className="vip">VIP</span>}{s.title}{i === ncmQueue.idx && <span className="bars"><i></i><i></i><i></i></span>}</b>
                <i>· {s.artist}{s.album ? ' · ' + s.album : ''} <span className="spark">✦</span></i>
              </div>
              <button className="x" onClick={(e) => removeRealAt(e, i)}>×</button>
            </div>
          )) : (list.length ? list : []).map((songI) => { const s = LS_SONGS[songI]; return (
            <div key={s.id} className={'ls-queue-item' + (songI === idx ? ' on' : '')} onClick={() => { setIdx(songI); onClose(); }}>
              <div className="si">
                <b>{songI % 3 === 0 && <span className="vip">VIP</span>}{s.title}{songI === idx && <span className="bars"><i></i><i></i><i></i></span>}</b>
                <i>· {s.artist} <span className="spark">✦</span></i>
              </div>
              <button className="x" onClick={(e) => removeAt(e, songI)}>×</button>
            </div>
          ); })}
          {!(real ? ncmQueue.list.length : list.length) && <div className="ls-empty"><div className="e-t">队列空了</div><div className="e-s">去曲库再添几首</div></div>}
        </div>
      </div>
    </div>
  );
}

// ── 评论 · 全屏 ────────────────────────────────────────
function LSCommentsFull({ song: songProp, idx, onClose }) {
  const song = songProp || LS_SONGS[idx] || window.LS_EMPTY_SONG;
  const realId = song && /^\d+$/.test(String(song.id)) ? song.id : null;
  const skey = 'ls-mycomments-' + (song && song.id);
  const [tab, setTab] = vUseState('ncm');
  const [ncmC, setNcmC] = vUseState(null);
  const [total, setTotal] = vUseState(0);
  const [mine, setMine] = vUseState(() => { try { return JSON.parse(localStorage.getItem(skey) || '[]'); } catch (e) { return []; } });
  const [draft, setDraft] = vUseState('');
  vUseEffect(() => {
    if (tab !== 'ncm' || !realId) return;
    let on = true; setNcmC(null);
    fetch((window.__LS_API || '/api') + '/ncm/comments?id=' + realId).then(r => r.json())
      .then(d => { if (on) { setNcmC(d.comments || []); setTotal(d.total || 0); } })
      .catch(() => { if (on) setNcmC([]); });
    return () => { on = false; };
  }, [tab, realId]);
  const fmtW = (n) => n >= 10000 ? (n / 10000).toFixed(1) + 'w' : n;
  const send = () => {
    if (!draft.trim()) return;
    const arr = [{ name: '我', text: draft.trim(), time: '刚刚' }, ...mine];
    setMine(arr); try { localStorage.setItem(skey, JSON.stringify(arr)); } catch (e) {}
    setDraft(''); setTab('mine');
  };
  return (
    <div className="ls-comments-full">
      <div className="ls-cf-top">
        <button className="back" onClick={onClose}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div className="ti">评论<span>{song.title}</span></div>
      </div>
      <div className="ls-cf-song">
        <div className="cv"><LSCover cover={song.cover} shape="rounded" radius={9} size={150} /></div>
        <div className="si"><b>{song.title}</b><i>{song.artist}{song.album ? ' · ' + song.album : ''}</i></div>
      </div>
      <div className="ls-cf-seg">
        <button className={tab === 'ncm' ? 'on' : ''} onClick={() => setTab('ncm')}>网易评论{total ? ' ' + fmtW(total) : ''}</button>
        <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>真实记录{mine.length ? ' ' + mine.length : ''}</button>
      </div>
      <div className="ls-cf-list">
        {tab === 'ncm' ? (
          !realId ? <div className="ls-cf-empty">播放网易云歌曲后可见热评</div>
          : ncmC === null ? <div className="ls-cf-loading">加载评论…</div>
          : ncmC.length ? ncmC.map((c, i) => (
            <div key={i} className="ls-cmt">
              <div className="av">{c.av ? <img src={c.av} alt="" /> : <span className="ava-ph"></span>}</div>
              <div className="main">
                <div className="nm"><b>{c.u}</b></div>
                <div className="tx">{c.t}</div>
                <div className="ft"><span>{c.time}</span><span className="zan">{c.z ? fmtW(c.z) : 0}</span></div>
              </div>
            </div>
          )) : <div className="ls-cf-empty">这首暂无热评</div>
        ) : (
          mine.length ? mine.map((c, i) => (
            <div key={i} className="ls-cmt">
              <div className="av"><image-slot id={LS_PEOPLE.eve.slot} shape="circle" placeholder=""></image-slot></div>
              <div className="main"><div className="nm"><b>{c.name}</b><span className="tag">我</span></div><div className="tx">{c.text}</div><div className="ft"><span>{c.time}</span></div></div>
            </div>
          )) : <div className="ls-cf-empty">还没有你的记录<br/>在下面写一条,或在歌词页问 Ta</div>
        )}
      </div>
      <div className="ls-cf-input">
        <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="写条评论…" />
        <button className="send" onClick={send}>{LSIcon.next()}</button>
      </div>
    </div>
  );
}

function lsNow(){var d=new Date();var h=d.getHours(),m=d.getMinutes();return (h<10?'0':'')+h+':'+(m<10?'0':'')+m;}
function lsHexRgba(hex, a){var h=String(hex||'#ffffff').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];var r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);if(isNaN(r))r=255;if(isNaN(g))g=255;if(isNaN(b))b=255;return 'rgba('+r+','+g+','+b+','+(a==null?1:a)+')';}
// ════════════ 悬浮球展开播放器 FullCenter ════════════
function LSFullCenter({ song, cur, dur, isPlaying, loved, ncmQueue, ncmLyric, playNcmIdx, doPlay, doPause, doNext, doLove, playMode, doMode, onClose, defaultTab, posStyle, onQuote }) {
  const [tab, setTab] = vUseState(defaultTab || 'lyrics');
  const fcBase = window.__LS_API || '/api';
  const lpRef = vUseRef({ t: 0, fired: false });
  const lpStart = function (line) { return function () { lpRef.current.fired = false; clearTimeout(lpRef.current.t); if (!onQuote || !line || /^[^:：]{1,12}[:：]/.test(line.trim())) return; lpRef.current.t = setTimeout(function () { lpRef.current.fired = true; try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} onQuote(line); }, 550); }; };
  const lpEnd = function () { clearTimeout(lpRef.current.t); };
  const [q, setQ] = vUseState('');
  const [results, setResults] = vUseState([]);
  const [searching, setSearching] = vUseState(false);
  const [playlists, setPlaylists] = vUseState(null);
  const [openPl, setOpenPl] = vUseState(null);
  const [tracks, setTracks] = vUseState([]);
  const doSearch = function () { if (!q.trim()) return; setSearching(true); fetch(fcBase + '/ncm/search?kw=' + encodeURIComponent(q.trim())).then(function (r) { return r.json(); }).then(function (d) { setResults((d && d.songs) || []); setSearching(false); }).catch(function () { setSearching(false); }); };
  vUseEffect(function () { if (tab === 'playlists' && playlists === null) { fetch(fcBase + '/ncm/playlists').then(function (r) { return r.json(); }).then(function (d) { setPlaylists((d && d.playlists) || []); }).catch(function () { setPlaylists([]); }); } }, [tab]);
  const openPlaylist = function (pl) { setOpenPl(pl); setTracks([]); fetch(fcBase + '/ncm/playlist?id=' + pl.id).then(function (r) { return r.json(); }).then(function (d) { setTracks((d && d.songs) || []); }).catch(function () {}); };
  const lyrics = ncmLyric ? lsParseLRC(ncmLyric) : ((song && song.lyrics) || []);
  let li = 0; lyrics.forEach(function (l, i) { if (cur >= l.t) li = i; });
  try { window.__lsCurLyric = (lyrics[li] && lyrics[li].line) || ''; } catch (e) {}
  const pct = dur ? Math.max(0, Math.min(100, cur / dur * 100)) : 0;
  // 歌词自动滚动：当前句滚到可视中间；用户手动滚动后停 3 秒
  const fcLyBox = vUseRef(null); const fcAuto = vUseRef(false); const fcHold = vUseRef(0);
  vUseEffect(function () {
    if (tab !== 'lyrics') return;
    if (Date.now() < fcHold.current) return;
    var box = fcLyBox.current; if (!box) return;
    var on = box.querySelector('.ll.on'); if (!on) return;
    var br = box.getBoundingClientRect(), or = on.getBoundingClientRect();
    var target = box.scrollTop + (or.top - br.top) - box.clientHeight / 2 + or.height / 2;
    fcAuto.current = true;
    try { box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' }); } catch (e) { box.scrollTop = Math.max(0, target); }
    setTimeout(function () { fcAuto.current = false; }, 620);
  }, [li, tab]);
  const fcScroll = function () { if (!fcAuto.current) fcHold.current = Date.now() + 3000; };
  const goPrev = function () { if (playNcmIdx && ncmQueue) playNcmIdx(ncmQueue.idx - 1); };
  const modeIcon = playMode === 'one' ? LSIcon.one : playMode === 'shuffle' ? LSIcon.shuffle : LSIcon.loop;
  return (
    <div className="fc glass" style={posStyle} onClick={function (e) { e.stopPropagation(); }}>
      <div className="fc-now">
        <button className="fc-x" onClick={onClose}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <div className="fc-head">
          <div className="cv"><LSCover cover={song.cover} shape="rounded" radius={12} size={120} /></div>
          <div className="ti"><span className="k">一起听</span><b>{song.title}</b><i>{song.artist}</i></div>
          <button className={'lv' + (loved ? ' on' : '')} onClick={doLove}><svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.2C.4 8.6 2 5 5.4 5c2 0 3.3 1.1 4.1 2.3C10.3 6.1 11.6 5 13.6 5 17 5 18.6 8.6 17 11.8 14.5 16.4 12 21 12 21z"/></svg></button>
        </div>
        <div className="fc-prog"><span>{lsFmt(cur)}</span><div className="track" onClick={function (e) { try { var r = e.currentTarget.getBoundingClientRect(); var t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur; window.__lsAudioEl.currentTime = t; } catch (er) {} }}><i style={{ width: pct + '%' }}></i></div><span>{lsFmt(dur)}</span></div>
        <div className="fc-ctrl">
          <button className="ic" onClick={doMode} title="播放模式">{modeIcon()}</button>
          <button className="ic" onClick={goPrev}>{LSIcon.prev()}</button>
          <button className="pp" onClick={function () { isPlaying ? doPause() : doPlay(); }}>{isPlaying ? LSIcon.pause() : LSIcon.play()}</button>
          <button className="ic" onClick={doNext}>{LSIcon.next()}</button>
        </div>
      </div>
      <div className="fc-tabs">
        {[['lyrics', '歌词'], ['search', '点歌'], ['playlists', '歌单'], ['queue', '待播']].map(function (t) {
          return <button key={t[0]} className={'fc-tab' + (tab === t[0] ? ' on' : '')} onClick={function () { setTab(t[0]); }}>{t[1]}</button>;
        })}
      </div>
      <div className="fc-body" ref={fcLyBox} onScroll={fcScroll}>
        {tab === 'lyrics' && (<div className="fc-lyrics">{lyrics.length ? lyrics.map(function (l, i) { return <div key={i} className={'ll' + (i === li ? ' on' : '')} onClick={function () { if (lpRef.current.fired) { lpRef.current.fired = false; return; } try { window.__lsAudioEl.currentTime = l.t; } catch (e) {} }} onPointerDown={lpStart(l.line)} onPointerUp={lpEnd} onPointerLeave={lpEnd} onPointerMove={lpEnd}>{l.line}</div>; }) : <div className="fc-empty">暂无歌词</div>}</div>)}
        {tab === 'search' && (<div className="fc-queue"><div className="fc-search"><input value={q} onChange={function (e) { setQ(e.target.value); }} onKeyDown={function (e) { if (e.key === 'Enter') doSearch(); }} placeholder="搜歌名 / 歌手" /><button onClick={doSearch}>搜</button></div>{searching ? <div className="fc-empty">搜索中…</div> : results.length ? results.map(function (s, i) { return <div key={s.id} className="qrow" onClick={function () { if (window.__lsPlayNcm) window.__lsPlayNcm(s, results, i); }}><span className="no">{i + 1 < 10 ? '0' + (i + 1) : i + 1}</span><div className="si"><b>{s.title}</b><i>{s.artist}</i></div><span className="pl-ic">{LSIcon.play()}</span></div>; }) : <div className="fc-empty">搜歌名或歌手,点一首一起听</div>}</div>)}
        {tab === 'playlists' && (<div className="fc-queue">{openPl ? (<div><div className="fc-subbar"><button onClick={function () { setOpenPl(null); }}>‹ 返回</button><b>{openPl.name}</b></div>{tracks.length ? tracks.map(function (s, i) { return <div key={s.id} className="qrow" onClick={function () { if (window.__lsPlayNcm) window.__lsPlayNcm(s, tracks, i); }}><span className="no">{i + 1 < 10 ? '0' + (i + 1) : i + 1}</span><div className="si"><b>{s.title}</b><i>{s.artist}</i></div><span className="pl-ic">{LSIcon.play()}</span></div>; }) : <div className="fc-empty">加载中…</div>}</div>) : (playlists === null ? <div className="fc-empty">加载歌单…</div> : playlists.length ? playlists.map(function (pl) { return <div key={pl.id} className="qrow" onClick={function () { openPlaylist(pl); }}><div className="pl-cv"><LSCover cover={pl.cover} shape="rounded" radius={8} size={80} /></div><div className="si"><b>{pl.name}</b><i>{pl.count} 首</i></div><span className="pl-ic">›</span></div>; }) : <div className="fc-empty">还没有歌单</div>)}</div>)}
        {tab === 'queue' && (<div className="fc-queue">{(ncmQueue && ncmQueue.list && ncmQueue.list.length) ? ncmQueue.list.map(function (s, i) { return <div key={i} className={'qrow' + (i === ncmQueue.idx ? ' on' : '')} onClick={function () { if (playNcmIdx) playNcmIdx(i); }}><span className="no">{i + 1 < 10 ? '0' + (i + 1) : i + 1}</span><div className="si"><b>{s.title}</b><i>{s.artist}</i></div>{i === ncmQueue.idx && <span className="bars"><i></i><i></i><i></i></span>}</div>; }) : <div className="fc-empty">待播队列还空着</div>}</div>)}
      </div>
    </div>
  );
}

// ════════════ 点歌聊 / 评论 视图 ════════════
function LSChatView({ tab, setTab, idx, setIdx, playing, setPlaying, ncmSong, ncmLyric, ncmQueue, playNcmIdx, cyclePlayMode, playMode, loved, setLoved, cur, addToLib }) {
  const [comments, setComments] = vUseState(LS_COMMENTS.map(c => ({ ...c })));
  const [draft, setDraft] = vUseState('');
  const [chat, setChat] = vUseState(() => { try { const r = localStorage.getItem('ls-room-chat'); if (r) { const a = JSON.parse(r); if (a && a.length) return a.map(function (m) { return (m && m.time === '此刻') ? Object.assign({}, m, { time: '' }) : m; }); } } catch (e) {} return []; });
  vUseEffect(() => { try { localStorage.setItem('ls-room-chat', JSON.stringify(chat.filter(function (m) { return !m.pending; }).slice(-120))); } catch (e) {} }, [chat]);
  const [busy, setBusy] = vUseState(false);
  const [topStyle, setTopStyle] = vUseState(() => { try { return localStorage.getItem('ls-room-top') || 'baseline'; } catch (e) { return 'baseline'; } });
  const [bgOn, setBgOn] = vUseState(() => { try { return localStorage.getItem('ls-room-bg-on') === '1'; } catch (e) { return false; } });
  const [roomSetOpen, setRoomSetOpen] = vUseState(false);
  const [ballOpen, setBallOpen] = vUseState(false);
  const [ballStyle, setBallStyle] = vUseState(function () { try { return localStorage.getItem('ls-room-ball') || 'island'; } catch (e) { return 'island'; } });
  const [hideEvents, setHideEvents] = vUseState(function () { try { return localStorage.getItem('ls-room-hideevt') === '1'; } catch (e) { return false; } });
  const [cardStyle, setCardStyle] = vUseState(function () { try { return localStorage.getItem('ls-room-card') || 'full'; } catch (e) { return 'full'; } });
  const [hideAvas, setHideAvas] = vUseState(function () { try { return localStorage.getItem('ls-room-hideava') === '1'; } catch (e) { return false; } });
  const [bub, setBub] = vUseState(function () { try { return JSON.parse(localStorage.getItem('ls-room-bubble') || 'null'); } catch (e) { return null; } });
  const [lovedLocal, setLovedLocal] = vUseState(false);
  const [, forceTick] = vUseState(0);
  const chatRef = vUseRef(null);
  const sysRef = vUseRef({ init: false, title: '', playing: null, mode: '' });
  const analyzedRef = vUseRef({});

  const audio = window.__lsAudioEl;
  const isPlaying = (playing != null) ? playing : (audio ? !audio.paused : true);
  const song = ncmSong || (ncmQueue && ncmQueue.list && ncmQueue.list.length ? ncmQueue.list[ncmQueue.idx] : LS_SONGS[idx]) || window.LS_EMPTY_SONG;
  const dur = (song && song.dur) || (audio && audio.duration) || 0;
  const position = (cur != null) ? cur : (audio ? (audio.currentTime || 0) : 0);
  const pct = dur ? Math.max(0, Math.min(100, position / dur * 100)) : 0;
  const lovedNow = (loved != null) ? loved : lovedLocal;
  const playModeIcon = playMode === 'one' ? LSIcon.one : playMode === 'shuffle' ? LSIcon.shuffle : LSIcon.loop;
  const playModeName = playMode === 'one' ? '单曲循环' : playMode === 'shuffle' ? '随机播放' : '列表循环';
  const playModeShort = playMode === 'one' ? '单曲' : playMode === 'shuffle' ? '随机' : '循环';

  const pickTop = (k) => { setTopStyle(k); try { localStorage.setItem('ls-room-top', k); } catch (e) {} };
  const toggleBg = () => setBgOn(v => { const nv = !v; try { localStorage.setItem('ls-room-bg-on', nv ? '1' : '0'); } catch (e) {} return nv; });
  const toggleAvas = () => setHideAvas(function (h) { const nh = !h; try { localStorage.setItem('ls-room-hideava', nh ? '1' : '0'); } catch (e) {} return nh; });
  const [lyrQuote, setLyrQuote] = vUseState('');
  const [lyrQuoteSong, setLyrQuoteSong] = vUseState('');
  vUseEffect(function () { try { var pq = window.__lsPendingQuote; if (pq && pq.line) { setLyrQuote(pq.line); setLyrQuoteSong(pq.song || ''); window.__lsPendingQuote = null; } } catch (e) {} }, []);
  const [replyMode, setReplyMode] = vUseState(function () { try { return localStorage.getItem('ls-room-replymode') || 'bubbles'; } catch (e) { return 'bubbles'; } });
  const setRM = function (v) { setReplyMode(v); try { localStorage.setItem('ls-room-replymode', v); } catch (e) {} };
  const [timeAware, setTimeAware] = vUseState(function () { try { return localStorage.getItem('ls-room-timeaware') !== '0'; } catch (e) { return true; } });
  const toggleTimeAware = () => setTimeAware(function (v) { const nv = !v; try { localStorage.setItem('ls-room-timeaware', nv ? '1' : '0'); } catch (e) {} return nv; });
  // 房间背景层在弹层最底（app.jsx 渲染，铺到顶栏后面），这里只负责显隐
  vUseEffect(function () {
    var el = document.querySelector('.ls-room-wallbg');
    if (el) el.style.display = bgOn ? '' : 'none';
  }, [bgOn]);
  // 气泡自定义：{ other:{c,a,b}, self:{c,a,b} } — c 颜色 / a 透明度 0-1 / b 磨砂 px。null = 跟随皮肤默认
  const bubDef = (wk) => ({ c: '#ffffff', a: 1, b: wk === 'other' ? 10 : 0 });
  const setBubPart = (wk, patch) => setBub(function (b) {
    const nb = Object.assign({}, b || {});
    nb[wk] = Object.assign({}, nb[wk] || bubDef(wk), patch);
    try { localStorage.setItem('ls-room-bubble', JSON.stringify(nb)); } catch (e) {}
    return nb;
  });
  const resetBub = () => { setBub(null); try { localStorage.removeItem('ls-room-bubble'); } catch (e) {} };
  // 界面玻璃设置：五个对象各自 透明度 a(0-100) / 磨砂 b(0-30px)。null = 皮肤默认
  const glassDef = { head: { a: 0, b: 0 }, card: { a: 100, b: 16 }, evt: { a: 42, b: 0 }, input: { a: 100, b: 18 }, share: { a: 82, b: 0 }, bg: { a: 60, b: 0 } };
  const [glass, setGlass] = vUseState(function () { try { return JSON.parse(localStorage.getItem('ls-room-glass') || 'null'); } catch (e) { return null; } });
  const setGlassPart = (k, patch) => setGlass(function (g) {
    const ng = Object.assign({}, g || {});
    ng[k] = Object.assign({}, ng[k] || glassDef[k], patch);
    try { localStorage.setItem('ls-room-glass', JSON.stringify(ng)); } catch (e) {}
    return ng;
  });
  const resetGlass = () => { setGlass(null); try { localStorage.removeItem('ls-room-glass'); } catch (e) {} };
  vUseEffect(function () {
    // 变量必须注在皮肤变量(--ls-*)可解析的元素上：custom property 值里的 var() 在声明处解析，
    // 挂 html 根会解析不到 .ls-app 上的皮肤变量导致整个值失效（踩过的坑）
    var host = document.querySelector('.ls-room-wrap') || document.querySelector('.ls-app') || document.documentElement;
    var r = host.style;
    var bases = { head: 'var(--ls-panel)', card: 'color-mix(in srgb, var(--ls-panel) 15%, #fff)', evt: 'var(--ls-panel)', input: 'var(--ls-panel)', share: 'var(--ls-panel2)' };
    ['head', 'card', 'evt', 'input', 'share'].forEach(function (k) {
      var g = glass && glass[k];
      if (g) { r.setProperty('--lsg-' + k + '-bg', 'color-mix(in srgb, ' + bases[k] + ' ' + g.a + '%, transparent)'); r.setProperty('--lsg-' + k + '-blur', (g.b || 0) + 'px'); }
      else { r.removeProperty('--lsg-' + k + '-bg'); r.removeProperty('--lsg-' + k + '-blur'); }
    });
    var gb = glass && glass.bg;
    if (gb) { r.setProperty('--lsg-bg-veil', 'color-mix(in srgb, var(--ls-bg) ' + gb.a + '%, transparent)'); r.setProperty('--lsg-bg-blur', (gb.b || 0) + 'px'); }
    else { r.removeProperty('--lsg-bg-veil'); r.removeProperty('--lsg-bg-blur'); }
  }, [glass]);
  // 悬浮球拖动：位置存 localStorage，拖动距离超过阈值时抑制展开点击
  const [fbPos, setFbPos] = vUseState(function () { try { return JSON.parse(localStorage.getItem('ls-room-fbpos') || 'null'); } catch (e) { return null; } });
  const fbDrag = vUseRef(null); const fbMoved = vUseRef(false);
  const fbDown = (e) => {
    const orb = e.currentTarget; const fb = orb.parentNode; const host = fb.parentNode;
    const fr = fb.getBoundingClientRect(); const hr = host.getBoundingClientRect();
    fbDrag.current = { sx: e.clientX, sy: e.clientY, ox: fr.left - hr.left, oy: fr.top - hr.top, w: fr.width, h: fr.height, hw: hr.width, hh: hr.height };
    fbMoved.current = false;
    try { orb.setPointerCapture(e.pointerId); } catch (er) {}
  };
  const fbMove = (e) => {
    const d = fbDrag.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 8) fbMoved.current = true;
    if (!fbMoved.current) return;
    const x = Math.max(4, Math.min(d.hw - d.w - 4, d.ox + dx));
    const y = Math.max(4, Math.min(d.hh - d.h - 4, d.oy + dy));
    setFbPos({ x: x, y: y });
  };
  const fbUp = () => {
    if (!fbDrag.current) return;
    fbDrag.current = null;
    setFbPos(function (p) { if (p) { try { localStorage.setItem('ls-room-fbpos', JSON.stringify(p)); } catch (e) {} } return p; });
  };
  const fbTap = (fn) => () => { if (fbMoved.current) { fbMoved.current = false; return; } fn(); };
  // 展开面板贴着悬浮球弹出：优先球上方居中对齐，放不下换球下方，永远 clamp 在房间内
  const [fcPos, setFcPos] = vUseState(null);
  vUseEffect(function () {
    if (!ballOpen) { setFcPos(null); return; }
    var t = setTimeout(function () {
      var host = document.querySelector('.ls-room2'); if (!host) return;
      var fb = host.querySelector('.fb'), fc = host.querySelector('.fc');
      if (!fb || !fc) return;
      var hr = host.getBoundingClientRect(), fr = fb.getBoundingClientRect();
      // offsetWidth/Height 不受 fcPop 弹出动画的 scale 影响（rect 在动画中会量出缩小值，导致面板压住球）
      var w = fc.offsetWidth || 300, h = fc.offsetHeight || 400;
      var left = (fr.left - hr.left) + fr.width / 2 - w / 2;
      left = Math.max(10, Math.min(hr.width - w - 10, left));
      var top = (fr.top - hr.top) - h - 10;
      if (top < 8) top = (fr.bottom - hr.top) + 10;
      top = Math.max(8, Math.min(hr.height - h - 8, top));
      setFcPos({ left: left, top: top });
    }, 40);
    return function () { clearTimeout(t); };
  }, [ballOpen, fbPos]);
  const bubVars = {};
  if (bub && bub.other) { bubVars['--lsr-bub-other'] = lsHexRgba(bub.other.c, bub.other.a); bubVars['--lsr-blur-other'] = (bub.other.b || 0) + 'px'; }
  if (bub && bub.self) { bubVars['--lsr-bub-self'] = lsHexRgba(bub.self.c, bub.self.a); bubVars['--lsr-blur-self'] = (bub.self.b || 0) + 'px'; }

  // “一起听了”实时时长（起点存 localStorage）
  const elapsed = (() => {
    let start;
    try { const raw = localStorage.getItem('ls-room-start'); if (raw && !isNaN(parseInt(raw, 10))) start = parseInt(raw, 10); else { start = Date.now(); localStorage.setItem('ls-room-start', String(start)); } } catch (e) { start = Date.now(); }
    const mins = Math.max(0, Math.floor((Date.now() - start) / 60000));
    if (mins < 60) return mins + ' 分钟';
    const h = Math.floor(mins / 60), m = mins % 60;
    return h + ' 小时' + (m ? ' ' + m + ' 分钟' : '');
  })();

  // 一秒一跳：进度 / 时长 / 时长实时刷新
  vUseEffect(() => { const t = setInterval(() => forceTick(x => (x + 1) % 100000), 1000); return () => clearInterval(t); }, []);

  // 房间样式（自包含注入，无需外部 CSS；照搬原生房间视觉质感，全用 --ls-* token）
  vUseEffect(() => {
    if (document.getElementById('ls-room-style2')) return;
    const st = document.createElement('style'); st.id = 'ls-room-style2';
    st.textContent = [
      ".ls-rbg{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none}",
      ".ls-rbg image-slot{width:100%;height:100%;display:block;pointer-events:auto}",
      ".ls-rbg::after{content:'';position:absolute;inset:0;background:var(--lsg-bg-veil,color-mix(in srgb,var(--ls-bg) 60%,transparent));backdrop-filter:blur(var(--lsg-bg-blur,0px));-webkit-backdrop-filter:blur(var(--lsg-bg-blur,0px));pointer-events:none}",
      ".ls-room-inner{position:relative;z-index:1;flex:1;min-height:0;display:flex;flex-direction:column}",
      ".ls-rtools{display:flex;align-items:center;gap:6px;padding:12px 2px 2px}",
      ".ls-rtools button{padding:5px 13px;border-radius:20px;font-family:var(--ls-cn);font-size:12px;color:var(--ls-ink-dim);background:var(--ls-panel);border:1px solid var(--ls-line-soft);cursor:pointer;transition:.15s}",
      ".ls-rtools button.on{color:var(--ls-gold);border-color:var(--ls-line);background:color-mix(in srgb,var(--ls-gold) 10%,transparent)}",
      ".ls-rtools .sp{flex:1}",
      ".ls-rtop{margin:10px 14px 12px;padding:16px 18px;border-radius:22px;background:color-mix(in srgb,var(--ls-panel) 50%,transparent);border:1px solid var(--ls-line-soft);box-shadow:0 14px 36px var(--ls-shadow);backdrop-filter:blur(20px) saturate(1.35);-webkit-backdrop-filter:blur(20px) saturate(1.35)}",
      ".ls-rtop-base .faces{display:flex;align-items:center;justify-content:center}",
      ".ls-rtop-base .faces .f{width:52px;height:52px;border-radius:50%;overflow:hidden;position:relative;background:var(--ls-panel2)}",
      ".ls-rtop-base .faces .f image-slot,.ls-rtop-base .faces .f .ls-w-face{width:100%;height:100%;display:block}",
      ".ls-rtop-base .faces .yu{box-shadow:0 0 0 2px var(--ls-you-color,var(--ls-gold))}",
      ".ls-rtop-base .faces .eve{box-shadow:0 0 0 2px var(--ls-eve-color,var(--ls-gold));margin-left:-12px}",
      ".ls-rtop-base .faces .cord{width:44px;height:20px;color:var(--ls-ink-faint);opacity:.55;margin:0 -2px}",
      ".ls-rtop-base .faces .cord svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.4}",
      ".ls-rtop .meta{text-align:center;margin-top:10px}",
      ".ls-rtop .meta .t{font-family:var(--ls-serif-d,var(--ls-serif));font-style:italic;font-size:17px;color:var(--ls-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".ls-rtop .meta .s{font-family:var(--ls-meta);font-size:11px;color:var(--ls-ink-dim);margin-top:4px}",
      ".ls-rtop .prog{display:flex;align-items:center;gap:9px;margin-top:13px}",
      ".ls-rtop .prog .c,.ls-rtop .prog .d{font-family:var(--ls-meta);font-size:10px;color:var(--ls-ink-faint);flex-shrink:0;min-width:30px}",
      ".ls-rtop .prog .d{text-align:right}",
      ".ls-rtop .prog .track{flex:1;height:3px;border-radius:999px;background:var(--ls-line);overflow:hidden}",
      ".ls-rtop .prog .track i{display:block;height:100%;border-radius:999px;background:var(--ls-gold);width:0}",
      ".ls-rtop .prog .pp{width:30px;height:30px;border-radius:50%;flex-shrink:0;background:var(--ls-gold);color:var(--ls-panel);border:none;display:flex;align-items:center;justify-content:center;cursor:pointer}",
      ".ls-skin-xueqing .ls-rtop .prog .pp{color:#1a1512}",
      ".ls-rtop .prog .pp svg{width:15px;height:15px;fill:currentColor}",
      ".ls-rtop-cass .head{display:grid;grid-template-columns:56px 1fr 56px;align-items:center;gap:10px}",
      ".ls-rtop-cass .reel{width:56px;height:56px;border-radius:50%;overflow:hidden;position:relative;border:7px solid color-mix(in srgb,var(--ls-ink) 14%,transparent);background:radial-gradient(circle,var(--ls-panel) 0 7px,var(--ls-panel2) 8px)}",
      ".ls-rtop-cass .reel.cover{border-width:4px}",
      ".ls-rtop-cass .reel.cover .ls-cover-img,.ls-rtop-cass .reel.cover image-slot{width:100%;height:100%;display:block}",
      ".ls-rtop-cass .reel.spin{animation:lsReelSpin 6s linear infinite}",
      ".ls-rtop-cass .reel i{position:absolute;inset:38%;border-radius:50%;background:var(--ls-ink-faint);opacity:.45}",
      ".ls-rtop-cass .mid{min-width:0;text-align:center}",
      ".ls-rtop-cass .mid b{display:block;font-family:var(--ls-serif-d,var(--ls-serif));font-style:italic;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ls-ink)}",
      ".ls-rtop-cass .mid span{display:block;font-family:var(--ls-meta);font-size:10px;color:var(--ls-ink-dim);margin-top:4px}",
      ".ls-rtop-cass .line{height:2px;border-radius:999px;margin:12px 6px 0;background:linear-gradient(90deg,transparent,var(--ls-gold),transparent);opacity:.5}",
      "@keyframes lsReelSpin{to{transform:rotate(360deg)}}",
      ".ls-rbtns{display:flex;gap:6px;padding:8px 14px 8px;flex-shrink:0}",
      ".ls-rbtns button{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:9px 2px;border-radius:13px;background:color-mix(in srgb,var(--ls-panel) 48%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--ls-line-soft);color:var(--ls-ink-dim);font-family:var(--ls-cn);font-size:10px;cursor:pointer;transition:.15s}",
      ".ls-rbtns button:hover{border-color:var(--ls-line)}",
      ".ls-rbtns button.on{color:var(--ls-gold);border-color:var(--ls-line);background:color-mix(in srgb,var(--ls-gold) 10%,transparent)}",
      ".ls-rbtns button svg{width:18px;height:18px;fill:currentColor;stroke:none}",
      ".ls-rbtns button.mode svg{fill:none;stroke:currentColor}",
      ".ls-rbtns button.love svg{fill:none;stroke:currentColor;stroke-width:1.7}",
      ".ls-rbtns button.love.on svg{fill:#e6455f;stroke:none}",
      ".ls-rbtns button.love.on{color:#e6455f;border-color:var(--ls-line-soft);background:color-mix(in srgb,var(--ls-panel) 48%,transparent)}",
      ".lsr-chat{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;margin:0 -10px;padding:6px 4px 8px;scrollbar-width:none}",
      ".lsr-chat::-webkit-scrollbar{width:0}",
      ".lsr-row{display:flex;align-items:flex-start;gap:10px;margin:7px 0}",
      ".lsr-row.self{justify-content:flex-end}",
      ".lsr-row.other{justify-content:flex-start}",
      ".lsr-ava{width:42px;height:42px;border-radius:50%;overflow:hidden;flex-shrink:0;background:var(--ls-panel2);border:1px solid color-mix(in srgb, #fff 72%, var(--ls-bg))}",
      ".lsr-ava .ls-w-face,.lsr-ava image-slot{width:100%;height:100%;display:block}",
      ".lsr-ava.ghost{visibility:hidden}",
      ".lsr-col{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:min(76%,300px);position:relative}",
      ".lsr-chat.noava .lsr-col{max-width:min(88%,360px)}",
      ".lsr-row.self .lsr-col{align-items:flex-end}",
      ".lsr-row.other .lsr-col{align-items:flex-start}",
      ".lsr-bubble{max-width:100%;border-radius:20px;padding:7px 11px 8px;line-height:1.7;font-size:13px;font-family:var(--ls-cn);white-space:pre-wrap;overflow-wrap:anywhere}",
      ".lsr-row.self .lsr-bubble{background:var(--lsr-bub-self,color-mix(in srgb, var(--ls-panel) 15%, #fff));color:var(--ls-ink);border:1px solid color-mix(in srgb, #fff 72%, var(--ls-bg));border-bottom-right-radius:6px;backdrop-filter:blur(var(--lsr-blur-self,0px));-webkit-backdrop-filter:blur(var(--lsr-blur-self,0px))}",
      ".lsr-row.other .lsr-bubble{background:var(--lsr-bub-other,color-mix(in srgb, var(--ls-bg) 15%, #fff));color:var(--ls-ink);border:1px solid color-mix(in srgb, #fff 72%, var(--ls-bg));border-bottom-left-radius:6px;backdrop-filter:blur(var(--lsr-blur-other,10px));-webkit-backdrop-filter:blur(var(--lsr-blur-other,10px))}",
      ".lsr-time{font-family:var(--ls-meta);font-size:9px;color:var(--ls-ink-faint);position:absolute;bottom:2px;white-space:nowrap}",
      ".lsr-row.other .lsr-time{left:100%;margin-left:5px}",
      ".lsr-row.self .lsr-time{right:100%;margin-right:5px}",
      ".lsr-row.runfirst{margin-top:7px}",
      ".lsr-bq{margin:0 0 6px;padding:6px 10px;border-radius:10px;background:color-mix(in srgb,var(--ls-ink) 8%,transparent);font-size:12px;line-height:1.55;color:var(--ls-ink-dim);white-space:pre-wrap}",
      ".lsr-bq .bq-src{display:block;font-size:9.5px;opacity:.72;margin-bottom:2px;font-family:var(--ls-meta)}",
      ".lsr-quotebar{display:flex;align-items:center;gap:8px;margin:0 14px 4px;padding:7px 12px;border-radius:12px;background:color-mix(in srgb,var(--ls-panel) 55%,transparent);border:1px solid var(--ls-line-soft);font-family:var(--ls-cn);font-size:12px;color:var(--ls-ink-dim)}",
      ".lsr-quotebar span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".lsr-quotebar button{border:none;background:none;color:var(--ls-ink-faint);font-size:16px;cursor:pointer;padding:0 2px}",
      ".lsr-think{max-width:100%;font-family:var(--ls-cn)}",
      ".lsr-think summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--ls-ink-faint);padding:2px 9px;border-radius:10px;background:color-mix(in srgb,var(--ls-panel) 40%,transparent)}",
      ".lsr-think summary::-webkit-details-marker{display:none}",
      ".lsr-think .tk{margin-top:4px;padding:8px 12px;border-radius:12px;background:color-mix(in srgb,var(--ls-panel) 30%,transparent);border:1px dashed var(--ls-line-soft);font-size:11.5px;line-height:1.65;color:var(--ls-ink-dim);white-space:pre-wrap}",
      ".lsr-share{display:flex;align-items:center;gap:11px;width:min(300px,78vw);max-width:100%;padding:9px 11px;border-radius:16px;background:var(--lsg-share-bg,color-mix(in srgb,var(--ls-panel2) 82%,transparent));backdrop-filter:blur(var(--lsg-share-blur,0px));-webkit-backdrop-filter:blur(var(--lsg-share-blur,0px));border:1px solid var(--ls-line-soft);box-shadow:0 6px 18px var(--ls-shadow);cursor:pointer;transition:.15s}",
      ".lsr-share:hover{border-color:var(--ls-line)}",
      ".lsr-share .cv{width:46px;height:46px;border-radius:10px;overflow:hidden;flex-shrink:0;position:relative}",
      ".lsr-share .cv .ls-cover-img,.lsr-share .cv image-slot{width:100%;height:100%;display:block}",
      ".lsr-share .mn{flex:1;min-width:0}",
      ".lsr-share .mn .eb{font-family:var(--ls-meta);font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--ls-ink-faint);margin-bottom:3px}",
      ".lsr-share .mn b{display:block;font-family:var(--ls-cn);font-size:13.5px;font-weight:600;color:var(--ls-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".lsr-share .mn span{display:block;font-family:var(--ls-meta);font-size:10px;font-style:normal;color:var(--ls-ink-faint);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".lsr-share .pl{width:30px;height:30px;border-radius:50%;flex-shrink:0;background:#fff;color:#5a5560;box-shadow:0 2px 8px rgba(0,0,0,.12);border:none;display:flex;align-items:center;justify-content:center;cursor:pointer}",
      ".lsr-share .pl svg{width:14px;height:14px;fill:currentColor}",
      ".lsr-event{align-self:center;max-width:86%;margin:6px auto;padding:6px 15px;border-radius:14px;text-align:center;background:var(--lsg-evt-bg,color-mix(in srgb,var(--ls-panel) 42%,transparent));backdrop-filter:blur(var(--lsg-evt-blur,0px));-webkit-backdrop-filter:blur(var(--lsg-evt-blur,0px));border:1px solid var(--ls-line-soft);box-shadow:0 6px 16px var(--ls-shadow);font-family:var(--ls-meta);font-size:11px;line-height:1.5;color:var(--ls-ink-dim)}"
    ].join('\n');
    document.head.appendChild(st);
  }, []);


  // 新消息滚到底
  vUseEffect(() => { const el = chatRef.current; if (el) el.scrollTop = el.scrollHeight; }, [chat.length]);

  const toggleLike = (i) => setComments(cs => cs.map((c, j) => j === i
    ? { ...c, liked: !c.liked, likes: c.likes + (c.liked ? -1 : 1) } : c));

  // 底部功能按钮（handler 优先 props，未传则退回全局）；手点先标记 user，盖掉可能残留的 AI 标记
  const markUser = () => { window.__lsActor = { who: 'user', t: Date.now() }; };
  const doPlay = () => { markUser(); if (setPlaying) setPlaying(true); else if (window.__lsRunAction) window.__lsRunAction({ type: 'resume' }); else if (audio) audio.play().catch(function () {}); };
  const doPause = () => { markUser(); if (setPlaying) setPlaying(false); else if (window.__lsRunAction) window.__lsRunAction({ type: 'pause' }); else if (audio) audio.pause(); };
  const doNext = () => { markUser(); if (playNcmIdx && ncmQueue) playNcmIdx(ncmQueue.idx + 1); else if (window.__lsRunAction) window.__lsRunAction({ type: 'next' }); };
  const doPrev = () => { markUser(); if (playNcmIdx && ncmQueue) playNcmIdx(ncmQueue.idx - 1); else if (window.__lsRunAction) window.__lsRunAction({ type: 'prev' }); };
  const doMode = () => { markUser(); if (cyclePlayMode) cyclePlayMode(); };
  const doLove = () => {
    const willLove = !lovedNow;
    if (setLoved) setLoved(willLove); else setLovedLocal(willLove);
    // 真实网易云歌：同步红心到「我喜欢的音乐」（取消也同步）
    window.__lsActor = { who: 'user', t: Date.now() };
    if (song && song.id && /^\d+$/.test(String(song.id))) { try { fetch((window.__LS_API || '/api') + '/ncm/like?id=' + song.id + '&like=' + (willLove ? 1 : 0), { method: 'POST' }).catch(function () {}); } catch (e) {} }
    if (willLove && window.__lsRoomEvent && song && song.title) window.__lsRoomEvent('红心了《' + song.title + '》');
    if (willLove && song && song.id) {
      if (addToLib) { try { addToLib(song); } catch (e) {} }
      else { try { const st = window.__lsStore; if (st && st.library && !st.library.some(x => x.songId === song.id)) { st.library.unshift({ songId: song.id, title: song.title, artist: song.artist, cover: song.cover, pinned: false, notes: 0, last: Date.now() }); if (window.lsSaveStore) window.lsSaveStore(st); } } catch (e) {} }
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const qv = lyrQuote; const qsongName = lyrQuoteSong || (song && song.title) || ''; setLyrQuote(''); setLyrQuoteSong('');
    setDraft('');
    const userMsg = { who: 'eve', t: text, quote: qv || undefined, qsong: qv ? qsongName : undefined, time: lsNow(), ts: Date.now() };
    setChat(c => [...c, userMsg]);
    bcast(userMsg);
    // 仅「点歌聊」走 AI DJ；其余标签保持原样
    if (tab !== 'chat' || !(window.claude && window.claude.complete)) return;
    setBusy(true);
    setChat(c => [...c, { who: 'yu', t: '…', time: lsNow(), pending: true }]);
    // 带上房间最近的对话当上下文（宫殿式多轮，而不是每条都单轮）
    const hist = chat.filter(m => m && !m.sys && !m.pending && m.t).slice(-12).map(m => ({ role: m.who === 'eve' ? 'user' : 'assistant', content: m.t }));
    const promptText = qv ? ('（指着正在放的这句歌词跟你说：「' + qv + '」）\n' + text) : text;
    hist.push({ role: 'user', content: promptText });
    let reply = '';
    try { reply = await window.claude.complete(promptText, { history: hist.slice(0, -1), quote: qv || undefined }); } catch (e) { reply = ''; }
    reply = String(reply || '');
    // AI DJ：抽取 <<ACT>>{...}<<>> 交给播放器执行，再从展示文本里删掉整段
    const ACT = /<<ACT>>(\{[\s\S]*?\})<<>>/;
    const m = reply.match(ACT);
    if (m) { try { const act = JSON.parse(m[1]); if (window.__lsRunAction) window.__lsRunAction(act); } catch (e) {} }
    const shown = reply.replace(/<<ACT>>(\{[\s\S]*?\})<<>>/g, '').trim();
    const think = String(window.__lsLastThink || ''); try { window.__lsLastThink = ''; } catch (e) {}
    const isStream = (function () { try { return localStorage.getItem('ls-room-replymode') === 'stream'; } catch (e) { return false; } })();
    // 分气泡模式按换行拆条；完整模式整段一条、带思考链
    const parts = isStream ? (shown ? [shown] : []) : shown.split(/\n+/).map(x => x.trim()).filter(Boolean);
    const aiMsgs = (parts.length ? parts : ['（放好了，一起听）']).map(t2 => ({ who: 'yu', t: t2, time: lsNow(), ts: Date.now() }));
    if (isStream && think && aiMsgs.length) aiMsgs[0].think = think;
    setChat(c => {
      const arr = c.slice();
      for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].pending) { arr.splice(i, 1, ...aiMsgs); break; } }
      return arr;
    });
    aiMsgs.forEach(bcast);
    setBusy(false);
  };

  const distKm = (function () { try { return localStorage.getItem('ls-edit-pf-dist') || LS_STATS.distanceKm; } catch (e) { return LS_STATS.distanceKm; } })();
  const yuName = (window.LS_PEOPLE && window.LS_PEOPLE.yu.name) || 'AI';
  const eveName = (window.LS_PEOPLE && window.LS_PEOPLE.eve.name) || 'You';

  const songById = (id) => LS_SONGS.find(s => s.id === id);
  const playShared = (s) => { const i = LS_SONGS.indexOf(s); if (i >= 0 && setIdx) setIdx(i); if (setPlaying) setPlaying(true); else if (window.__lsRunAction) window.__lsRunAction({ type: 'resume' }); };
  // 分享歌曲：把一首歌作为卡片发进聊天（用户点按钮分享当前歌；AI 经 <<ACT>>{"type":"share"}<<>> 进来）
  const pushShare = (whoKey, ov) => {
    const s = ov || song;
    if (!s || !s.id) return;
    const shareMsg = { who: whoKey === 'ai' ? 'yu' : 'eve', share: { id: s.id, title: s.title, artist: s.artist || '', cover: s.cover || '', url: s.url || '' }, time: lsNow(), ts: Date.now() };
    setChat(c => [...c, shareMsg]);
    bcast(shareMsg);
  };
  // 房间消息广播 + 服务端时间线：说的话/分享/AI 回复经 WS 落库并同步给同房间的人
  const bcast = (msg) => { try { if (window.__LS_SYNC && window.__LS_SYNC.send) window.__LS_SYNC.send({ t: 'chat', msg: msg }); } catch (e) {} };
  vUseEffect(function () {
    window.__lsRoomShare = function (whoKey, ov) { pushShare(whoKey, ov); };
    window.__lsOpenRoomSet = function () { setRoomSetOpen(true); };
    window.__lsRoomChatIn = function (msg) { if (msg && (msg.t || msg.share)) setChat(function (c) { return [...c, msg]; }); };
    return function () { if (window.__lsRoomShare) delete window.__lsRoomShare; if (window.__lsOpenRoomSet) delete window.__lsOpenRoomSet; if (window.__lsRoomChatIn) delete window.__lsRoomChatIn; };
  });
  // 进房间先拉服务端历史（换设备/清缓存不丢）；拉不到就用本地缓存兜底
  vUseEffect(function () {
    var room = (window.__LS_SYNC && window.__LS_SYNC.room && window.__LS_SYNC.room()) || 'main';
    fetch((window.__LS_API || '/api') + '/room/events?room=' + encodeURIComponent(room) + '&limit=150')
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok && Array.isArray(d.events)) setChat(function (prev) { var k = function (e) { return (e.who || '') + '|' + (e.t || '') + '|' + (e.time || ''); }; var seen = {}; var out = d.events.slice(); d.events.forEach(function (e) { seen[k(e)] = 1; }); (prev || []).forEach(function (e) { if (!seen[k(e)]) out.push(e); }); out.sort(function (a, b) { return ((a && a.ts) || 0) - ((b && b.ts) || 0); }); return out; }); })
      .catch(function () {});
  }, []);
  const playSharedNcm = (sh) => { if (window.__lsPlayNcm) window.__lsPlayNcm({ id: sh.id, title: sh.title, artist: sh.artist, cover: sh.cover, url: sh.url || undefined }, null, 0); };
  // 选歌分享：点分享键弹面板，可直接分享当前歌，也可搜索点选任意一首
  const [sharePickOpen, setSharePickOpen] = vUseState(false);
  const [spq, setSpq] = vUseState('');
  const [spRes, setSpRes] = vUseState([]);
  const [spBusy, setSpBusy] = vUseState(false);
  const spSearch = () => {
    const q = spq.trim(); if (!q || spBusy) return;
    setSpBusy(true);
    fetch((window.__LS_API || '/api') + '/ncm/search?kw=' + encodeURIComponent(q)).then(r => r.json()).then(d => { setSpRes((d && d.songs) || []); setSpBusy(false); }).catch(() => setSpBusy(false));
  };
  const [spConfirm, setSpConfirm] = vUseState(null);
  const roomSeek = (e) => { try { const r = e.currentTarget.getBoundingClientRect(); const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur; if (window.__lsAudioEl) window.__lsAudioEl.currentTime = t; if (setCur) setCur(Math.floor(t)); } catch (er) {} };

  return (
    <div className="ls-body ls-room2" style={{ display: 'flex', flexDirection: 'column', position: 'relative', minHeight: 0 }}>

      <div className={'ls-rcard rc-' + cardStyle}>
        {cardStyle !== 'full' && <button className="rgear" onClick={() => setSharePickOpen(true)} title="分享歌曲到房间"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg></button>}
        {cardStyle === 'full' ? (
          <>
            {/* 耳机线双头像：一人一只耳机，线垂下绕到播放小卡后面 */}
            <div className="rbond">
              <svg className="rcord" viewBox="0 0 300 170" preserveAspectRatio="xMidYMin meet">
                <path d="M42 44 C 18 84, 30 132, 118 148" />
                <path d="M258 44 C 282 84, 270 132, 182 148" />
                <circle cx="42" cy="41" r="3.2" /><circle cx="258" cy="41" r="3.2" />
              </svg>
              <div className="who">
                <div className="bub"><LSEdit eid="room-bub-yu" def="今天也一起听" /></div>
                <div className="f yu"><LSFace who="yu" /></div>
              </div>
              <div className="who">
                <div className="bub"><LSEdit eid="room-bub-eve" def="嗯嗯！" /></div>
                <div className="f eve"><LSFace who="eve" /></div>
              </div>
              <div className="nms">{yuName}<i>·</i>{eveName}</div>
            </div>
            <div className="rstat">相距 {distKm} 公里，一起听了 {elapsed}</div>
            <div className="rplayer">
              <div className="rsong"><b>{song.title}</b>{song.artist ? <i> — {song.artist}</i> : null}</div>
              <div className="rprog">
                <span className="c">{lsFmt(position)}</span>
                <div className="track" onClick={roomSeek}><i style={{ width: pct + '%' }}></i></div>
                <span className="d">-{lsFmt(Math.max(0, dur - position))}</span>
              </div>
              <div className="rctl">
                <button className={'love' + (lovedNow ? ' on' : '')} onClick={doLove} title="收藏这首"><svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.2C.4 8.6 2 5 5.4 5c2 0 3.3 1.1 4.1 2.3C10.3 6.1 11.6 5 13.6 5 17 5 18.6 8.6 17 11.8 14.5 16.4 12 21 12 21z"/></svg></button>
                <button onClick={doPrev} title="上一首">{LSIcon.prev()}</button>
                <button className="pp" onClick={isPlaying ? doPause : doPlay} title={isPlaying ? '暂停' : '播放'}>{isPlaying ? LSIcon.pause() : LSIcon.play()}</button>
                <button onClick={doNext} title="下一首">{LSIcon.next()}</button>
                <button className="mode" onClick={doMode} title={playModeName}>{playModeIcon()}</button>
                <button className="shr" onClick={() => setSharePickOpen(true)} title="分享歌曲到房间"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg></button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* 极简条：窄 mini 播放器 —— 左黑胶封面旋转，右歌名歌手 + 控制，底部细进度线 */}
            <div className="mrow">
              <div className={'mdisc' + (isPlaying ? ' spin' : '')}><LSCover cover={song.cover} shape="circle" size={100} /></div>
              <div className="mmeta"><b>{song.title}</b><i>{song.artist || ''}</i></div>
              <div className="mbtns">
                <button onClick={doPrev} title="上一首">{LSIcon.prev()}</button>
                <button className="pp" onClick={isPlaying ? doPause : doPlay} title={isPlaying ? '暂停' : '播放'}>{isPlaying ? LSIcon.pause() : LSIcon.play()}</button>
                <button onClick={doNext} title="下一首">{LSIcon.next()}</button>
                <button className={'love' + (lovedNow ? ' on' : '')} onClick={doLove} title="收藏这首"><svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.2C.4 8.6 2 5 5.4 5c2 0 3.3 1.1 4.1 2.3C10.3 6.1 11.6 5 13.6 5 17 5 18.6 8.6 17 11.8 14.5 16.4 12 21 12 21z"/></svg></button>
              </div>
            </div>
            <div className="mprog-row">
              <span className="c">{lsFmt(position)}</span>
              <div className="mprog" onClick={roomSeek}><i style={{ width: pct + '%' }}></i></div>
              <span className="d">-{lsFmt(Math.max(0, dur - position))}</span>
            </div>
          </>
        )}
      </div>

      <div className={'lsr-chat' + (hideAvas ? ' noava' : '')} ref={chatRef} style={{ flex: 1, minHeight: 0, ...bubVars }}>
        {chat.map((m, i) => {
          if (m.sys || m.who === 'sys') return hideEvents ? null : <div key={i} className="lsr-event">{m.t}</div>;
          const self = m.who === 'eve';
          const s = m.songId && songById(m.songId);
          const prev = chat[i - 1];
          const firstOfRun = !prev || prev.sys || prev.who === 'sys' || prev.who !== m.who;
          return (
            <div key={i} className={'lsr-row ' + (self ? 'self' : 'other') + (firstOfRun && i > 0 ? ' runfirst' : '')}>
              {!self && !hideAvas && (firstOfRun ? <div className="lsr-ava"><LSFace who="yu" /></div> : <div className="lsr-ava ghost"></div>)}
              <div className="lsr-col">
                {m.think ? <details className="lsr-think"><summary>💭 思考过程</summary><div className="tk">{m.think}</div></details> : null}
                {(m.t || m.quote) ? <div className="lsr-bubble">{m.quote ? <div className="lsr-bq"><span className="bq-src">♪ {m.qsong || '歌词'}</span>{m.quote}</div> : null}{m.t}</div> : null}
                {m.share && (<div className="lsr-share" onClick={() => playSharedNcm(m.share)}><div className="cv"><LSCover cover={m.share.cover} shape="rounded" radius={10} size={120} /></div><div className="mn"><div className="eb">{(self ? eveName : yuName) + ' · 分享'}</div><b>{m.share.title}</b><span>{m.share.artist}</span></div><button className="pl" onClick={(e) => { e.stopPropagation(); playSharedNcm(m.share); }}>{String(song.id) === String(m.share.id) && isPlaying ? <span className="eq2"><i></i><i></i><i></i></span> : LSIcon.play()}</button></div>)}
                {s && (<div className="lsr-share" onClick={() => playShared(s)}><div className="cv"><LSCover cover={s.cover} shape="rounded" radius={10} size={120} /></div><div className="mn"><div className="eb">{(self ? eveName : yuName) + ' · 分享'}</div><b>{s.title}</b><span>{s.artist}</span></div><button className="pl" onClick={(e) => { e.stopPropagation(); playShared(s); }}>{LSIcon.play()}</button></div>)}
                {m.time ? <div className="lsr-time">{m.time}</div> : null}
              </div>
              {self && !hideAvas && (firstOfRun ? <div className="lsr-ava"><LSFace who="eve" /></div> : <div className="lsr-ava ghost"></div>)}
            </div>
          );
        })}
      </div>

      <div className={'fb fb-' + ballStyle + (ballOpen ? ' open' : '')} style={fbPos ? { left: fbPos.x + 'px', top: fbPos.y + 'px', right: 'auto', bottom: 'auto' } : null}>
        {ballStyle === 'island' ? (
          <div className="orb pill" onClick={fbTap(() => setBallOpen(o => !o))} onPointerDown={fbDown} onPointerMove={fbMove} onPointerUp={fbUp} onPointerCancel={fbUp}>
            <div className="cv"><LSCover cover={song.cover} shape="circle" size={80} /></div>
            <div className="pl"><b>{song.title}</b><i>{song.artist ? song.artist + ' · ' : ''}一起听</i></div>
            <span className="eq"><i></i><i></i><i></i></span>
          </div>
        ) : (
          <div className="orb eqorb" onClick={fbTap(() => setBallOpen(o => !o))} onPointerDown={fbDown} onPointerMove={fbMove} onPointerUp={fbUp} onPointerCancel={fbUp}><span className="eq"><i></i><i></i><i></i><i></i></span></div>
        )}
      </div>
      {/* 展开面板贴着悬浮球弹出（js 计算位置防出屏），定位前隐藏避免闪跳 */}
      {ballOpen && <LSFullCenter song={song} cur={position} dur={dur} isPlaying={isPlaying} loved={lovedNow} ncmQueue={ncmQueue} ncmLyric={ncmLyric} playNcmIdx={playNcmIdx} doPlay={doPlay} doPause={doPause} doNext={doNext} doLove={doLove} playMode={playMode} doMode={doMode} onClose={() => setBallOpen(false)} onQuote={(line) => { setLyrQuote(line); setLyrQuoteSong((song && song.title) || ''); setBallOpen(false); }} defaultTab={ballStyle === 'island' ? 'queue' : 'lyrics'} posStyle={fcPos ? { left: fcPos.left + 'px', top: fcPos.top + 'px', right: 'auto', bottom: 'auto', margin: 0 } : { visibility: 'hidden' }} />}

      {lyrQuote ? <div className="lsr-quotebar"><span>❝ {lyrQuote}</span><button onClick={() => { setLyrQuote(''); setLyrQuoteSong(''); }}>×</button></div> : null}
      <div className="ls-input">
        <div className="box"><input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="边听边说…" /><button className="send" onClick={send}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg></button></div>
      </div>

      {roomSetOpen && (
        <div className="ls-rset-mask" onClick={() => setRoomSetOpen(false)}>
          <div className="ls-rset" onClick={e => e.stopPropagation()}>
            <div className="hd">房间设置</div>
            <div className="row"><span>回复样式</span><div className="fcseg"><button className={replyMode !== 'stream' ? 'on' : ''} onClick={() => setRM('bubbles')}>分气泡</button><button className={replyMode === 'stream' ? 'on' : ''} onClick={() => setRM('stream')}>完整带思考</button></div></div>
            <div className="row"><span>顶栏样式</span><div className="fcseg"><button className={cardStyle === 'full' ? 'on' : ''} onClick={() => { setCardStyle('full'); try { localStorage.setItem('ls-room-card', 'full'); } catch (e) {} }}>完整卡</button><button className={cardStyle === 'mini' ? 'on' : ''} onClick={() => { setCardStyle('mini'); try { localStorage.setItem('ls-room-card', 'mini'); } catch (e) {} }}>极简条</button></div></div>
            <div className="row"><span>悬浮球样式</span><div className="fcseg"><button className={ballStyle === 'island' ? 'on' : ''} onClick={() => { setBallStyle('island'); try { localStorage.setItem('ls-room-ball', 'island'); } catch (e) {} }}>灵动岛</button><button className={ballStyle === 'sheet' ? 'on' : ''} onClick={() => { setBallStyle('sheet'); try { localStorage.setItem('ls-room-ball', 'sheet'); } catch (e) {} }}>声波球</button></div></div>
            <div className="row"><span>隐藏播放状态卡片</span><button className={'tg' + (hideEvents ? ' on' : '')} onClick={() => setHideEvents(function (h) { const nh = !h; try { localStorage.setItem('ls-room-hideevt', nh ? '1' : '0'); } catch (e) {} return nh; })}></button></div>
            <div className="row"><span>隐藏气泡头像</span><button className={'tg' + (hideAvas ? ' on' : '')} onClick={toggleAvas}></button></div>
            <div className="row"><span>时间感知（AI 知道现在几点）</span><button className={'tg' + (timeAware ? ' on' : '')} onClick={toggleTimeAware}></button></div>
            <div className="ls-rset-sub">气泡样式（颜色 · 透明度 · 磨砂）</div>
            {[['other', 'AI'], ['self', '我']].map(([wk, wl]) => {
              const cfg = (bub && bub[wk]) || bubDef(wk);
              return (
                <div className="bubrow" key={wk}>
                  <span className="wl">{wl}</span>
                  <input type="color" value={cfg.c} onChange={e => setBubPart(wk, { c: e.target.value })} />
                  <label>透明<input type="range" min="10" max="100" value={Math.round(cfg.a * 100)} onChange={e => setBubPart(wk, { a: Number(e.target.value) / 100 })} /></label>
                  <label>磨砂<input type="range" min="0" max="20" value={cfg.b || 0} onChange={e => setBubPart(wk, { b: Number(e.target.value) })} /></label>
                </div>
              );
            })}
            {bub && <button className="bubreset" onClick={resetBub}>气泡恢复皮肤默认</button>}
            <div className="ls-rset-sub">界面透明度与磨砂</div>
            {[['head', '顶栏'], ['card', '顶卡'], ['evt', '状态卡'], ['input', '输入框'], ['share', '分享卡'], ['bg', '背景蒙版']].map(([gk, gl]) => {
              const g = (glass && glass[gk]) || glassDef[gk];
              return (
                <div className="bubrow" key={gk}>
                  <span className="wl g">{gl}</span>
                  <label>透明<input type="range" min="0" max="100" value={g.a} onChange={e => setGlassPart(gk, { a: Number(e.target.value) })} /></label>
                  <label>磨砂<input type="range" min="0" max="30" value={g.b || 0} onChange={e => setGlassPart(gk, { b: Number(e.target.value) })} /></label>
                </div>
              );
            })}
            {glass && <button className="bubreset" onClick={resetGlass}>界面恢复皮肤默认</button>}
            <div className="row"><span>房间背景</span><button className={'tg' + (bgOn ? ' on' : '')} onClick={toggleBg}></button></div>
            {bgOn && <div className="rbgset"><image-slot id="ls-room-bg" cap="3000" shape="rounded" radius="12" always-ctl="" tap-replace="" placeholder="点这里设置房间背景图"></image-slot></div>}
            <button className="done" onClick={() => setRoomSetOpen(false)}>完成</button>
          </div>
        </div>
      )}

      {sharePickOpen && (
        <div className="ls-rset-mask" onClick={() => setSharePickOpen(false)}>
          <div className="ls-rset spk" onClick={e => e.stopPropagation()}>
            <div className="hd">分享歌曲</div>
            <button className="spk-now" onClick={() => setSpConfirm(song)}>分享正在听的《{song.title}》</button>
            <div className="spk-search"><input value={spq} onChange={e => setSpq(e.target.value)} onKeyDown={e => e.key === 'Enter' && spSearch()} placeholder="或者搜一首想分享的歌…" /><button onClick={spSearch}>搜</button></div>
            {!spRes.length && !spBusy && ncmQueue && ncmQueue.list && ncmQueue.list.length ? <div className="spk-sub">播放列表 · 点歌名分享 · 点 ▶ 换歌</div> : null}
            <div className="spk-list">
              {spBusy ? <div className="spk-empty">搜索中…</div> : (() => {
                const lst = spRes.length ? spRes : ((ncmQueue && ncmQueue.list) || []);
                return lst.length ? lst.map((s2, i2) => (
                  <div key={(s2.id || i2) + '_' + i2} className="spk-row" onClick={() => setSpConfirm(s2)}>
                    <div className="cv"><LSCover cover={s2.cover} shape="rounded" radius={8} size={80} /></div>
                    <div className="si"><b>{s2.title}</b><i>{s2.artist}</i></div>
                    <button className="spk-play" title="切过去一起听" onClick={(e) => { e.stopPropagation(); if (window.__lsPlayNcm) window.__lsPlayNcm(s2, lst, i2); setSharePickOpen(false); }}>{LSIcon.play({ width: 13, height: 13 })}</button>
                  </div>
                )) : <div className="spk-empty">点上面直接分享当前的，或搜一首点选分享</div>;
              })()}
            </div>
          </div>
        </div>
      )}

      {spConfirm && (
        <div className="ls-rset-mask spc-mask" onClick={() => setSpConfirm(null)}>
          <div className="spc" onClick={e => e.stopPropagation()}>
            <div className="spc-t">分享《{spConfirm.title}》到房间？</div>
            <div className="spc-btns">
              <button className="no" onClick={() => setSpConfirm(null)}>取消</button>
              <button className="yes" onClick={() => { pushShare('user', spConfirm); setSpConfirm(null); setSharePickOpen(false); }}>分享</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LSDanmu({ idx }) {
  const song = LS_SONGS[idx] || window.LS_EMPTY_SONG;
  return (
    <div className="ls-danmu-wrap">
      <div className="cover-bg"><LSCover cover={song.cover} shape="rect" size={500} /></div>
      <div className="veil"></div>
      {LS_DANMU.map((d, i) => (
        <div key={i} className="ls-dan" style={{
          top: (8 + (i % 7) * 26) + 'px',
          animationDuration: (11 + (i % 4) * 3) + 's',
          animationDelay: (-i * 1.7) + 's',
        }}>{d}</div>
      ))}
    </div>
  );
}

// ════════════ 小组件画廊 ════════════
function LSGalleryView({ idx, playing, setPlaying, onFocus }) {
  const song = LS_SONGS[idx] || window.LS_EMPTY_SONG;
  const toggle = () => setPlaying(p => !p);
  return (
    <div className="ls-body">
      <div className="ls-gallery">
        <div style={{ padding: '2px 0 2px' }}>
          <div style={{ fontFamily: 'var(--ls-serif)', fontStyle: 'italic', fontSize: 15, color: 'var(--ls-ink-dim)', lineHeight: 1.6 }}>
            八种把「我们正在一起听」<br/>放到桌面上的方式。点一下试试播放。
          </div>
        </div>
        {LS_WIDGETS.map(w => {
          const C = w.comp;
          return (
            <div className="ls-w-block" key={w.id}>
              <div className="ls-w-head">
                <span className="n">{w.name}</span>
                <span className="t">{w.title}</span>
                <span className="d" style={{ cursor: 'pointer' }} onClick={() => onFocus(w.id)}>{w.desc} · 放大 ⤢</span>
              </div>
              <C song={song} playing={playing} onToggle={toggle} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LSFocusOverlay({ wid, idx, playing, setPlaying, onClose }) {
  const w = LS_WIDGETS.find(x => x.id === wid);
  if (!w) return null;
  const C = w.comp;
  const song = LS_SONGS[idx] || window.LS_EMPTY_SONG;
  return (
    <div className="ls-focus-mask" onClick={onClose}>
      <div className="ls-focus-inner" onClick={e => e.stopPropagation()}>
        <C song={song} playing={playing} onToggle={() => setPlaying(p => !p)} />
      </div>
    </div>
  );
}

function LSSavePicker({ song, onClose }) {
  const [pls, setPls] = vUseState(null);
  const [msg, setMsg] = vUseState('');
  const base = window.__LS_API || '/api';
  // 支持单曲或多曲（批量收藏传数组）
  const songs = Array.isArray(song) ? song : [song];
  const ids = songs.map(function (s) { return s.id; }).join(',');
  vUseEffect(function () { fetch(base + '/ncm/playlists').then(function (r) { return r.json(); }).then(function (d) { setPls((d && d.playlists) || []); }).catch(function () { setPls([]); }); }, []);
  const add = function (pl) { fetch(base + '/ncm/playlist-add?pid=' + pl.id + '&id=' + ids, { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) { setMsg((d && d.ok) ? ('已收藏到「' + pl.name + '」') : '收藏失败'); if (d && d.ok && window.__lsRoomEvent && songs[0] && songs[0].title) window.__lsRoomEvent('把《' + songs[0].title + '》' + (songs.length > 1 ? ('等 ' + songs.length + ' 首') : '') + '收进了歌单「' + pl.name + '」'); setTimeout(onClose, 1200); }).catch(function () { setMsg('收藏失败'); }); };
  return (
    <div className="ls-savepick-mask" onClick={onClose}>
      <div className="ls-savepick" onClick={function (e) { e.stopPropagation(); }}>
        <div className="hd">收藏到歌单</div>
        <div className="sp-song">{songs.length > 1 ? ('已选 ' + songs.length + ' 首') : (songs[0].title + (songs[0].artist ? ' · ' + songs[0].artist : ''))}</div>
        {msg ? <div className="sp-msg">{msg}</div> : (
          <div className="sp-list">
            {pls === null ? <div className="sp-empty">加载歌单…</div> : pls.length ? pls.map(function (pl) {
              return <div key={pl.id} className="sp-row" onClick={function () { add(pl); }}><div className="cv"><LSCover cover={pl.cover} shape="rounded" radius={8} size={80} /></div><div className="si"><b>{pl.name}</b><i>{pl.count} 首</i></div></div>;
            }) : <div className="sp-empty">还没有歌单</div>}
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { LSPlayerView, LSChatView, LSGalleryView, LSFocusOverlay, LSDanmu, LSQueueSheet, LSCommentsFull, LSSavePicker });
