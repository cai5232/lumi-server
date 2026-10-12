/* listen/views3.jsx — 曲库（搜索 + 日推 + 私人FM）· 歌单（资料/歌单风，照参考图3）。
   依赖 data.jsx、widgets.jsx（LSIcon / LSCover）、features2.jsx（LSFMView）、store.jsx（__ncm* 缓存层）。 */

const { useState: v3UseState, useEffect: v3UseEffect } = React;
const lsById = (id) => LS_SONGS.find(s => s.id === id);

// ════════════ 曲库 ════════════
function LSBrowseView({ onPlay, onOpenSong, onOpenFM }) {
  const [q, setQ] = v3UseState('');
  const [tab, setTab] = v3UseState('daily');   // daily | recent
  const LSAPI = (typeof window !== 'undefined' && window.__LS_API) || '/api';
  // 登录态初值优先缓存 status，其次 localStorage（切页零闪）
  const [ncmLogged, setNcmLogged] = v3UseState(() => {
    const st = window.__ncmCache && window.__ncmCache.status;
    if (st != null) return !!st.logged;
    return !!localStorage.getItem('ls-ncm');
  });
  const [ncmDaily, setNcmDaily] = v3UseState(() => (window.__ncmCache && window.__ncmCache.recommend) || null);   // 真实每日推荐（null=未加载）
  const [ncmResults, setNcmResults] = v3UseState(null);  // 真实搜索结果
  const [ncmArtists, setNcmArtists] = v3UseState(null);  // 真实歌手搜索结果
  const [openArtist, setOpenArtist] = v3UseState(null);  // 当前展开的歌手 {id,name}
  const [artistSongs, setArtistSongs] = v3UseState([]);  // 展开歌手的热门歌
  v3UseEffect(() => {
    const st = window.__ncmCache && window.__ncmCache.status;
    if (st != null) { setNcmLogged(!!st.logged); return; }
    if (window.__ncmStatus) window.__ncmStatus().then(d => { if (d && d.logged) setNcmLogged(true); }).catch(() => {});
  }, []);
  v3UseEffect(() => {
    if (!ncmLogged) return;
    const rc = window.__ncmCache && window.__ncmCache.recommend;
    if (rc != null) { setNcmDaily(rc); return; }
    if (window.__ncmRecommend) window.__ncmRecommend().then(songs => { if (songs) setNcmDaily(songs); }).catch(() => {});
  }, [ncmLogged]);
  const playNcm = (song, list, i) => { if (window.__lsPlayNcm) window.__lsPlayNcm(song, list, i); else onPlay(song); };
  const doNcmSearch = () => { const kw = q.trim(); if (!ncmLogged || !kw) return; fetch(LSAPI + '/ncm/search?kw=' + encodeURIComponent(kw)).then(r => r.json()).then(d => { if (d && d.songs) setNcmResults(d.songs); }).catch(() => {}); setOpenArtist(null); setArtistSongs([]); fetch(LSAPI + '/ncm/search-artist?kw=' + encodeURIComponent(kw)).then(r => r.json()).then(d => { if (d && d.artists) setNcmArtists(d.artists); }).catch(() => {}); };
  const openNcmArtist = (a) => { if (openArtist && openArtist.id === a.id) { setOpenArtist(null); setArtistSongs([]); return; } setOpenArtist({ id: a.id, name: a.name }); setArtistSongs([]); fetch(LSAPI + '/ncm/artist-songs?id=' + a.id).then(r => r.json()).then(d => { if (d && d.songs) setArtistSongs(d.songs); }).catch(() => {}); };
  const ncmRow = (s, list, i, no) => (
    <div className="ls-songrow" key={(s.id || i) + '_ncm_' + i} onClick={() => playNcm(s, list, i)}>
      {no != null ? <span className="no">{String(no).padStart(2, '0')}</span> : null}
      <div className="cv"><LSCover cover={s.cover} size={100} /></div>
      <div className="si"><b>{s.title}</b><i>{s.artist}{s.reason ? ' · ' + s.reason : (s.album ? ' · ' + s.album : '')}</i></div>
    </div>
  );
  const localResults = q.trim()
    ? LS_SONGS.filter(s => (s.title + s.artist + s.album).toLowerCase().includes(q.trim().toLowerCase()))
    : null;
  const results = ncmLogged ? (q.trim() ? ncmResults : null) : localResults;
  const artists = (ncmLogged && q.trim()) ? ncmArtists : null;

  return (
    <div className="ls-body ls-browse">
      {/* 搜索框 */}
      <div className="ls-search">
        <svg onClick={doNcmSearch} style={{ cursor: 'pointer' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') doNcmSearch(); }} placeholder="搜歌名 · 歌手 · 专辑" />
        {q && <button className="clr" onClick={() => { setQ(''); setNcmResults(null); setNcmArtists(null); setOpenArtist(null); setArtistSongs([]); }}>×</button>}
      </div>

      {(results || (artists && artists.length)) ? (
        <div className="ls-search-res">
          {artists && artists.length ? (
            <div className="ls-artist-sec">
              <div className="ls-sec-h">歌手</div>
              <div className="ls-artist-list">
                {artists.map((a, i) => (
                  <div className={'ls-artist' + (openArtist && openArtist.id === a.id ? ' on' : '')} key={a.id || i} onClick={() => openNcmArtist(a)}>
                    <div className="av"><LSCover cover={a.cover} size={120} shape="circle" /></div>
                    <span className="nm">{a.name}</span>
                  </div>
                ))}
              </div>
              {openArtist ? (
                <div className="ls-artist-songs">
                  <div className="ls-sec-h">{openArtist.name} · 热门歌曲</div>
                  {artistSongs.length ? artistSongs.map((s, i) => ncmRow(s, artistSongs, i, i + 1)) : <div className="ls-empty"><div className="e-t">加载中…</div></div>}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="ls-sec-h">搜索 “{q}” · {results ? results.length : 0} 首</div>
          {results && results.length ? results.map((s, i) => (
            <div className="ls-songrow" key={(s.id || i) + '_sr_' + i} onClick={() => { if (ncmLogged && window.__lsOpenNcmSong) window.__lsOpenNcmSong(s); else onOpenSong(s); }}>
              <div className="cv"><LSCover cover={s.cover} size={100} /></div>
              <div className="si"><b>{s.title}</b><i>{s.artist}{s.album ? ' · ' + s.album : ''}</i></div>
              <button className="srch-play" title="立即播放" onClick={(e) => { e.stopPropagation(); if (ncmLogged) playNcm(s, results, i); else onPlay(s); }}>{LSIcon.play({ width: 13, height: 13 })}</button>
            </div>
          )) : <div className="ls-empty"><div className="e-t">{results ? '没有找到' : '加载中…'}</div>{results ? <div className="e-s">换个词试试</div> : null}</div>}
          <div className="ls-hot">
            <div className="ls-sec-h">热搜</div>
            <div className="ls-hot-tags">{LS_HOT.map((h, i) => <button key={i} onClick={() => setQ(h)}>{h}</button>)}</div>
          </div>
        </div>
      ) : (
        <>
          {/* 私人 FM 入口大卡 */}
          <button className="ls-fm-card" onClick={onOpenFM}>
            <div className="ic">{LSIcon.play({ width: 22, height: 22 })}</div>
            <div className="tx"><b>私人 FM</b><i>电台为你和 TA 挑 · 越听越懂</i></div>
            <span className="go">进入 ›</span>
          </button>

          {/* 日推 / 最近 分段 */}
          <div className="ls-browse-seg">
            <button className={tab === 'daily' ? 'on' : ''} onClick={() => setTab('daily')}>每日推荐</button>
            <button className={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>最近常听</button>
          </div>

          {tab === 'daily' && (
            <div className="ls-daily">
              <div className="ls-daily-hero">
                <div className="d">{new Date().getDate()}</div>
                <div className="m"><b>每日推荐</b><i>根据你和 TA 的口味 · 每天 6:00 更新</i></div>
              </div>
              {ncmLogged
                ? (ncmDaily === null
                    ? <div className="ls-empty"><div className="e-t">加载中…</div></div>
                    : ncmDaily.map((s, i) => ncmRow(s, ncmDaily, i, i + 1)))
                : (LS_DAILY.length ? LS_DAILY.map((d, i) => { const s = lsById(d.songId); if (!s) return null; return (
                    <div className="ls-songrow" key={i} onClick={() => onPlay(s)}>
                      <span className="no">{String(i + 1).padStart(2, '0')}</span>
                      <div className="cv"><LSCover cover={s.cover} size={100} /></div>
                      <div className="si"><b>{s.title}</b><i>{s.artist} · {d.reason}</i></div>
                      <button className="more" onClick={(e) => { e.stopPropagation(); onOpenSong(s); }}>›</button>
                    </div>
                  ); }) : <div className="ls-empty"><div className="e-t">登录网易云后显示每日推荐</div><div className="e-s">也可以直接搜索歌曲播放</div></div>)}
            </div>
          )}

          {tab === 'recent' && (
            <div className="ls-recent">
              {LS_RECENT.length ? LS_RECENT.map((r, i) => { const s = lsById(r.songId); if (!s) return null; return (
                <div className="ls-songrow" key={i} onClick={() => onPlay(s)}>
                  <div className="cv"><LSCover cover={s.cover} size={100} /></div>
                  <div className="si"><b>{s.title}</b><i>{s.artist} · 听过 {r.times} 次</i></div>
                  <span className="when">{r.when}</span>
                </div>
              ); }) : <div className="ls-empty"><div className="e-t">还没有最近常听</div><div className="e-s">播放真实歌曲后这里会有记录</div></div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ════════════ 歌单 / 资料（照参考图3）════════════
// 可编辑文字：失焦存 localStorage，刷新保留。AI可直接点改昵称/签名。
function LSEdit({ eid, tag, cls, def }) {
  const Tag = tag || 'span';
  const [v] = v3UseState(() => { const s = localStorage.getItem('ls-edit-' + eid); return s == null ? def : s; });
  return <Tag className={(cls || '') + ' ls-edit'} contentEditable suppressContentEditableWarning
    onBlur={e => localStorage.setItem('ls-edit-' + eid, e.currentTarget.textContent)}
    dangerouslySetInnerHTML={{ __html: v }} />;
}

// ════════════ 歌单 / 资料（仿原生网易云）════════════
function LSPlaylistView(props) {
  const { onPlay, onOpenSong } = props;

  // R9 openPl 展开态：优先 props(app 持有)，否则本地兜底
  const [openPlLocal, setOpenPlLocal] = v3UseState(null);
  const openPl = props.openPl !== undefined ? props.openPl : openPlLocal;
  const setOpenPl = props.setOpenPl || setOpenPlLocal;

  // R8 子页标签：null(主页) | recent | local | rank | deco
  const [sub, setSub] = v3UseState(null);

  // R4 登录态：初值优先缓存 status，其次 localStorage
  const [ncmUser, setNcmUser] = v3UseState(() => {
    const st = window.__ncmCache && window.__ncmCache.status;
    if (st != null) return st.logged ? (st.nickname || '已登录') : '';
    return localStorage.getItem('ls-ncm') || '';
  });
  const [login, setLogin] = v3UseState(false);
  const [qr, setQr] = v3UseState(null);
  const LSAPI = (typeof window !== 'undefined' && window.__LS_API) || '/api';
  v3UseEffect(() => {
    const st = window.__ncmCache && window.__ncmCache.status;
    if (st != null) { if (st.logged) setNcmUser(st.nickname || '已登录'); return; }
    if (window.__ncmStatus) window.__ncmStatus().then(d => { if (d && d.logged) setNcmUser(d.nickname || '已登录'); }).catch(() => {});
  }, []);
  const openLogin = () => { setLogin(true); setQr(null); fetch(LSAPI + '/ncm/qr').then(r => r.json()).then(d => { if (d && d.ok) setQr(d); }).catch(() => {}); };
  v3UseEffect(() => {
    if (!login || !qr || !qr.key) return;
    const t = setInterval(() => { fetch(LSAPI + '/ncm/check?key=' + encodeURIComponent(qr.key)).then(r => r.json()).then(c => { if (c && c.code === 803) { if (window.__ncmCacheClear) window.__ncmCacheClear(); setNcmUser(c.nickname || '已登录'); localStorage.setItem('ls-ncm', c.nickname || ''); setLogin(false); } else if (c && c.code === 800) { openLogin(); } }).catch(() => {}); }, 2500);
    return () => clearInterval(t);
  }, [login, qr]);

  // 真实网易云歌单（null=未加载） + 展开歌单曲目
  const [ncmPlaylists, setNcmPlaylists] = v3UseState(() => (window.__ncmCache ? window.__ncmCache.playlists : null));
  const [openTracks, setOpenTracks] = v3UseState([]);
  v3UseEffect(() => {
    if (!ncmUser) { setNcmPlaylists(null); return; }
    const pc = window.__ncmCache && window.__ncmCache.playlists;
    if (pc != null) { setNcmPlaylists(pc); return; }
    if (window.__ncmPlaylists) window.__ncmPlaylists().then(pls => { if (pls) setNcmPlaylists(pls); }).catch(() => {});
  }, [ncmUser]);
  const playNcm = (song, list, i) => { if (window.__lsPlayNcm) window.__lsPlayNcm(song, list, i); };
  const openNcmPl = (pl) => {
    setOpenPl({ id: pl.id, name: pl.name, ncm: true });
    setOpenTracks([]);
    fetch(LSAPI + '/ncm/playlist?id=' + pl.id).then(r => r.json()).then(d => { if (d && d.songs) setOpenTracks(d.songs); }).catch(() => {});
  };

  // R8 真实：最近播放 / 排行榜（登录后拉真数据；未登录为空状态）
  const [ncmRecent, setNcmRecent] = v3UseState(null);   // 真实最近播放（null=未加载）
  const [ncmTops, setNcmTops] = v3UseState(null);       // 排行榜列表（null=未加载）
  const [openTop, setOpenTop] = v3UseState(null);       // 当前展开的榜 {id,name}
  const [topTracks, setTopTracks] = v3UseState([]);     // 展开榜的曲目
  v3UseEffect(() => {
    if (sub !== 'recent' || !ncmUser) return;
    setNcmRecent(null);
    fetch(LSAPI + '/ncm/record').then(r => r.json()).then(d => { setNcmRecent((d && d.songs) || []); }).catch(() => setNcmRecent([]));
  }, [sub, ncmUser]);
  v3UseEffect(() => {
    if (sub !== 'rank' || !ncmUser) return;
    setNcmTops(null); setOpenTop(null); setTopTracks([]);
    fetch(LSAPI + '/ncm/toplist').then(r => r.json()).then(d => { setNcmTops((d && d.lists) || []); }).catch(() => setNcmTops([]));
  }, [sub, ncmUser]);
  const openNcmTop = (t) => {
    setOpenTop({ id: t.id, name: t.name });
    setTopTracks([]);
    fetch(LSAPI + '/ncm/toplist?id=' + t.id).then(r => r.json()).then(d => { if (d && d.songs) setTopTracks(d.songs); }).catch(() => {});
  };

  // R8/R10 装扮态：优先 props，否则本地兜底（setter 没传就退化为本地）
  const [wallOnL, setWallOnL] = v3UseState(false);
  const [wallVeilL, setWallVeilL] = v3UseState(0.3);
  const [wallBlurL, setWallBlurL] = v3UseState(0);
  const [cardVeilL, setCardVeilL] = v3UseState(1);
  const [cardBlurL, setCardBlurL] = v3UseState(0);
  const [navVeilL, setNavVeilL] = v3UseState(0.7);
  const [navBlurL, setNavBlurL] = v3UseState(14);
  // 歌单详情批量选择
  const [selMode, setSelMode] = v3UseState(false);
  const [selIds, setSelIds] = v3UseState({});
  const [delConfirm, setDelConfirm] = v3UseState(false);
  const [skinL, setSkinL] = v3UseState('auto');
  const wallOn   = props.wallOn   !== undefined ? props.wallOn   : wallOnL;
  const wallVeil = props.wallVeil !== undefined ? props.wallVeil : wallVeilL;
  const wallBlur = props.wallBlur !== undefined ? props.wallBlur : wallBlurL;
  const cardVeil = props.cardVeil !== undefined ? props.cardVeil : cardVeilL;
  const cardBlur = props.cardBlur !== undefined ? props.cardBlur : cardBlurL;
  const navVeil  = props.navVeil  !== undefined ? props.navVeil  : navVeilL;
  const navBlur  = props.navBlur  !== undefined ? props.navBlur  : navBlurL;
  const setNavVeil = props.setNavVeil || setNavVeilL;
  const setNavBlur = props.setNavBlur || setNavBlurL;
  const skin     = props.skin     !== undefined ? props.skin     : skinL;
  const customAc = props.customAc !== undefined ? props.customAc : '#c99bb0';
  const setCustomAc = props.setCustomAc || function () {};
  const customVars = props.customVars || {};
  const setCustomVars = props.setCustomVars || function () {};
  const darkMode = props.darkMode || false;
  const setDarkMode = props.setDarkMode || function () {};
  const setWallOn   = props.setWallOn   || setWallOnL;
  const setWallVeil = props.setWallVeil || setWallVeilL;
  const setWallBlur = props.setWallBlur || setWallBlurL;
  const setCardVeil = props.setCardVeil || setCardVeilL;
  const setCardBlur = props.setCardBlur || setCardBlurL;
  const setSkin     = props.setSkin     || setSkinL;

  const doLogout = () => { fetch(LSAPI + '/ncm/logout', { method: 'POST' }).catch(() => {}); if (window.__ncmCacheClear) window.__ncmCacheClear(); localStorage.removeItem('ls-ncm'); setNcmUser(''); };

  const songRow = (s, list, i) => (
    <div className="ls-songrow" key={(s.id || i) + '_' + i} onClick={() => onPlay(s, list)}>
      <span className="no">{String(i + 1).padStart(2, '0')}</span>
      <div className="cv"><LSCover cover={s.cover} size={100} /></div>
      <div className="si"><b>{s.title}</b><i>{s.artist}</i></div>
      <button className="more" onClick={(e) => { e.stopPropagation(); onOpenSong(s); }}></button>
    </div>
  );

  // R9 歌单点开：展开面板列出曲目（songs 是 id 数组，映射到 LS_SONGS）
  if (openPl) {
    if (openPl.ncm) {
      const selArr = openTracks.filter(s => selIds[s.id]);
      const exitSel = () => { setSelMode(false); setSelIds({}); };
      const batchDel = () => {
        const ids = selArr.map(s => s.id).join(',');
        fetch(LSAPI + '/ncm/playlist-del?pid=' + openPl.id + '&id=' + ids, { method: 'POST' }).then(r => r.json()).then(d => {
          if (d && d.ok) { setOpenTracks(ts => ts.filter(s => !selIds[s.id])); exitSel(); }
          setDelConfirm(false);
        }).catch(() => setDelConfirm(false));
      };
      const allOn = openTracks.length > 0 && openTracks.every(s => selIds[s.id]);
      return (
        <div className="ls-body ls-profile">
          <div className="ls-sec-h ls-subback" onClick={() => { setOpenPl(null); setOpenTracks([]); exitSel(); }}>← {openPl.name}</div>
          {openTracks.length ? (
            <div className="ls-pl-actions">
              <button className="primary" onClick={() => { if (window.__lsPlayNcm) window.__lsPlayNcm(openTracks[0], openTracks, 0); }}>{LSIcon.play({ width: 17, height: 17 })}播放全部</button>
              <button onClick={() => { if (window.__lsQueueAppend) window.__lsQueueAppend(openTracks); }}>加入播放列表</button>
              <button className={selMode ? 'selon' : ''} onClick={() => { selMode ? exitSel() : setSelMode(true); }}>{selMode ? '取消' : '批量'}</button>
            </div>
          ) : null}
          {openTracks.length
            ? openTracks.map((s, i) => (
                <div className="ls-songrow" key={(s.id || i) + '_' + i} onClick={() => { if (selMode) setSelIds(o => Object.assign({}, o, { [s.id]: !o[s.id] })); else if (window.__lsOpenNcmSong) window.__lsOpenNcmSong(s); else playNcm(s, openTracks, i); }}>
                  {selMode ? <span className={'selc' + (selIds[s.id] ? ' on' : '')}></span> : <span className="no">{String(i + 1).padStart(2, '0')}</span>}
                  <div className="cv"><LSCover cover={s.cover} size={100} /></div>
                  <div className="si"><b>{s.title}</b><i>{s.artist}</i></div>
                </div>
              ))
            : <div className="ls-empty"><div className="e-t">加载中…</div></div>}
          {selMode && (
            <div className="ls-batchbar">
              <button onClick={() => { if (allOn) { setSelIds({}); } else { const all = {}; openTracks.forEach(s => { all[s.id] = true; }); setSelIds(all); } }}>{allOn ? '全不选' : '全选'}</button>
              <button disabled={!selArr.length} onClick={() => { if (window.__lsPlayNcm) window.__lsPlayNcm(selArr[0], selArr, 0); exitSel(); }}>播放</button>
              <button disabled={!selArr.length} onClick={() => { if (window.__lsQueueAppend) window.__lsQueueAppend(selArr); exitSel(); }}>加列表</button>
              <button disabled={!selArr.length} onClick={() => { if (window.__lsSavePicker) window.__lsSavePicker(selArr); }}>加歌单</button>
              <button disabled={!selArr.length} className="dgr" onClick={() => setDelConfirm(true)}>删除</button>
              <span className="cnt">{selArr.length ? selArr.length + ' 首' : ''}</span>
            </div>
          )}
          {delConfirm && (
            <div className="ls-rset-mask spc-mask" onClick={() => setDelConfirm(false)}>
              <div className="spc" onClick={e => e.stopPropagation()}>
                <div className="spc-t">从「{openPl.name}」删除选中的 {selArr.length} 首？</div>
                <div className="spc-btns">
                  <button className="no" onClick={() => setDelConfirm(false)}>取消</button>
                  <button className="yes" onClick={batchDel}>删除</button>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }
    const songs = (openPl.songs || []).map(id => lsById(id) || LS_SONGS.find(x => x.id === id)).filter(Boolean);
    return (
      <div className="ls-body ls-profile">
        <div className="ls-sec-h ls-subback" onClick={() => setOpenPl(null)}>← {openPl.name}</div>
        {songs.length
          ? songs.map((s, i) => songRow(s, songs, i))
          : <div className="ls-empty"><div className="e-t">空歌单</div></div>}
      </div>
    );
  }

  const backHead = (title) => <div className="ls-sec-h ls-subback" onClick={() => setSub(null)}>← {title}</div>;

  // R8 子页：最近 → 真实最近播放（登录）/ 空状态（未登录）
  if (sub === 'recent') {
    if (ncmUser) {
      if (ncmRecent === null) return <div className="ls-body ls-profile">{backHead('最近播放')}<div className="ls-empty"><div className="e-t">加载中…</div></div></div>;
      return (
        <div className="ls-body ls-profile">{backHead('最近播放')}
          {ncmRecent.length ? ncmRecent.map((s, i) => (
            <div className="ls-songrow" key={(s.id || i) + '_r_' + i} onClick={() => { if (window.__lsOpenNcmSong) window.__lsOpenNcmSong(s); else playNcm(s, ncmRecent, i); }}>
              <span className="no">{String(i + 1).padStart(2, '0')}</span>
              <div className="cv"><LSCover cover={s.cover} size={100} /></div>
              <div className="si"><b>{s.title}</b><i>{s.artist}</i></div>
            </div>
          )) : <div className="ls-empty"><div className="e-t">还没有播放记录</div></div>}
        </div>
      );
    }
    const list = LS_RECENT.map(r => lsById(r.songId)).filter(Boolean);
    return <div className="ls-body ls-profile">{backHead('最近播放')}{list.length ? list.map((s, i) => songRow(s, list, i)) : <div className="ls-empty"><div className="e-t">还没有记录</div></div>}</div>;
  }
  // R8 子页：本地 → 自己粘贴音频直链添加歌曲（存 localStorage），点歌名即可一起听
  if (sub === 'local') {
    return <LSLocalSongs backHead={backHead} />;
  }
  // R8 子页：排行 → 真实排行榜，点榜展开曲目（登录）/ 空状态（未登录）
  if (sub === 'rank') {
    if (ncmUser) {
      if (openTop) {
        return (
          <div className="ls-body ls-profile">
            <div className="ls-sec-h ls-subback" onClick={() => { setOpenTop(null); setTopTracks([]); }}>← {openTop.name}</div>
            {topTracks.length ? (
              <div className="ls-pl-actions">
                <button className="primary" onClick={() => { if (window.__lsPlayNcm) window.__lsPlayNcm(topTracks[0], topTracks, 0); }}>{LSIcon.play({ width: 17, height: 17 })}播放全部</button>
                <button onClick={() => { if (window.__lsQueueAppend) window.__lsQueueAppend(topTracks); }}>加入播放列表</button>
              </div>
            ) : null}
            {topTracks.length ? topTracks.map((s, i) => (
              <div className="ls-songrow" key={(s.id || i) + '_t_' + i} onClick={() => { if (window.__lsOpenNcmSong) window.__lsOpenNcmSong(s); else playNcm(s, topTracks, i); }}>
                <span className="no">{String(i + 1).padStart(2, '0')}</span>
                <div className="cv"><LSCover cover={s.cover} size={100} /></div>
                <div className="si"><b>{s.title}</b><i>{s.artist}</i></div>
              </div>
            )) : <div className="ls-empty"><div className="e-t">加载中…</div></div>}
          </div>
        );
      }
      if (ncmTops === null) return <div className="ls-body ls-profile">{backHead('排行榜')}<div className="ls-empty"><div className="e-t">加载中…</div></div></div>;
      return (
        <div className="ls-body ls-profile">{backHead('排行榜')}
          {ncmTops.length ? ncmTops.map(t => (
            <div className="ls-pl-row" key={t.id} onClick={() => openNcmTop(t)}>
              <div className="cv"><LSCover cover={t.cover} size={120} radius={10} /></div>
              <div className="si"><b>{t.name}</b><i>{t.updateFrequency || '排行榜'}</i></div>
              <span className="play">{LSIcon.play({ width: 14, height: 14 })}</span>
            </div>
          )) : <div className="ls-empty"><div className="e-t">暂无排行榜</div></div>}
        </div>
      );
    }
    return <div className="ls-body ls-profile">{backHead('听歌排行')}{LS_SONGS.length ? LS_SONGS.map((s, i) => songRow(s, LS_SONGS, i)) : <div className="ls-empty"><div className="e-t">登录网易云后显示排行</div></div>}</div>;
  }

  // R8 装扮子页 + R10 背景设置/更换/清空
  if (sub === 'deco') {
    return (
      <div className="ls-body ls-profile">{backHead('装扮')}
        <div className="ls-deco">
          <div className="ls-skinrow">
            <button className={'sk sk-custom' + (skin === 'custom' ? ' on' : '')} title="自定义颜色" onClick={() => setSkin('custom')}><span className="sw" style={skin === 'custom' ? { background: customAc } : null}></span></button>
            {[['ningzhi', '凝脂'], ['douqing', '豆青'], ['xueqing', '雪青'], ['ouhe', '藕荷'], ['jilan', '霁蓝']].map(([k, l]) => (
              <button key={k} className={'sk sk-' + k + (skin === k ? ' on' : '')} onClick={() => setSkin(k)} title={l}><span className="sw"></span></button>
            ))}
          </div>
          {skin === 'custom' && (
            <div className="ls-diy">
              <label className="ls-diy-item"><span className="sw" style={{ background: customAc }}></span><span className="lb">主色</span><input type="color" value={customAc} onChange={e => { const val = e.target.value; setCustomAc(val); setSkin('custom'); try { localStorage.setItem('ls-skin-custom', val); } catch (x) {} }} /></label>
              {[['accent', '强调', '#b29a6e'], ['panel', '卡片', '#faf7f9'], ['ink', '文字', '#2b2530'], ['lyric', '歌词', '#a59c90'], ['line', '描边', '#e0d8dd']].map(([k, l, dv]) => (
                <label key={k} className="ls-diy-item"><span className="sw" style={{ background: customVars[k] || dv }}></span><span className="lb">{l}</span><input type="color" value={customVars[k] || dv} onChange={e => { const merged = Object.assign({}, customVars, { [k]: e.target.value }); setCustomVars(merged); setSkin('custom'); try { localStorage.setItem('ls-skin-diy', JSON.stringify(merged)); } catch (x) {} }} /></label>
              ))}
              <button className="ls-diy-reset" onClick={() => { setCustomVars({}); try { localStorage.removeItem('ls-skin-diy'); } catch (x) {} }}>重置各分块</button>
            </div>
          )}
          <div className="ls-darkrow"><div className="tx"><b>深色模式</b><i>一键反转明暗,面板控制不受影响</i></div><button className={'ls-wall-tg' + (darkMode ? ' on' : '')} onClick={() => { const nv = !darkMode; setDarkMode(nv); try { localStorage.setItem('ls-dark', nv ? '1' : '0'); } catch (e) {} }}></button></div>
          <div className="ls-bgbig"><image-slot id="ls-wallpaper" shape="rounded" radius="14" cap="3000" always-ctl tap-replace placeholder="点框设置背景大图"></image-slot></div>
          <div className="ls-wall-row" style={{ marginTop: 12 }}>
            <div className="tx"><b>显示背景</b><i>把背景大图铺在整个界面</i></div>
            <button className={'ls-wall-tg' + (wallOn ? ' on' : '')} onClick={() => setWallOn(v => !v)}></button>
          </div>
          <div className="ls-deco-sld">
            <label>背景蒙版<span>{Math.round((wallVeil || 0) * 100)}%</span></label>
            <input type="range" min="0" max="0.7" step="0.02" value={wallVeil} onChange={e => setWallVeil(parseFloat(e.target.value))} />
          </div>
          <div className="ls-deco-sld">
            <label>背景磨砂<span>{Math.round(wallBlur || 0)}px</span></label>
            <input type="range" min="0" max="12" step="1" value={wallBlur} onChange={e => setWallBlur(parseFloat(e.target.value))} />
          </div>
          <div className="ls-deco-sld">
            <label>卡片透明<span>{Math.round((cardVeil == null ? 1 : cardVeil) * 100)}%</span></label>
            <input type="range" min="0.2" max="1" step="0.02" value={cardVeil == null ? 1 : cardVeil} onChange={e => setCardVeil(parseFloat(e.target.value))} />
          </div>
          <div className="ls-deco-sld">
            <label>卡片磨砂<span>{Math.round(cardBlur || 0)}px</span></label>
            <input type="range" min="0" max="14" step="1" value={cardBlur || 0} onChange={e => setCardBlur(parseFloat(e.target.value))} />
          </div>
          <div className="ls-deco-sld">
            <label>底栏透明<span>{Math.round((navVeil == null ? 0.7 : navVeil) * 100)}%</span></label>
            <input type="range" min="0" max="1" step="0.02" value={navVeil == null ? 0.7 : navVeil} onChange={e => setNavVeil(parseFloat(e.target.value))} />
          </div>
          <div className="ls-deco-sld">
            <label>底栏磨砂<span>{Math.round(navBlur == null ? 14 : navBlur)}px</span></label>
            <input type="range" min="0" max="30" step="1" value={navBlur == null ? 14 : navBlur} onChange={e => setNavBlur(parseFloat(e.target.value))} />
          </div>
          <div className="ls-deco-note">背景 / 皮肤 / 透明度都会实时生效</div>
        </div>
      </div>
    );
  }

  // 主资料页
  return (
    <div className="ls-body ls-profile">
      {/* R6 头像单独设置 + R7 全部 DIY */}
      <div className="ls-pf-head">
        <div className="ls-pf-av"><image-slot id="ls-pf-avatar" shape="circle" always-ctl tap-replace placeholder=""></image-slot></div>
        <div className="ls-pf-namerow">
          <LSEdit eid="pf-name" tag="b" cls="ls-pf-name" def="You & AI" />
        </div>
        <LSEdit eid="pf-sign" tag="div" cls="ls-pf-sign" def="一起听歌" />
        <div className="ls-pf-stat">
          <span><b><LSEdit eid="pf-days" def="0" /></b>在一起</span>
          <span className="dv"></span>
          <span><b><LSEdit eid="pf-favs" def="0" /></b>共同收藏</span>
          <span className="dv"></span>
          <span><b><LSEdit eid="pf-sync" def="0" /></b>默契</span>
        </div>
      </div>

      {/* R8 标签：最近/本地/排行/装扮 */}
      <div className="ls-pf-tabs">
        {[['recent', '最近'], ['local', '本地'], ['rank', '排行'], ['deco', '装扮']].map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)}>{l}</button>
        ))}
      </div>

      {/* R4 网易云登录入口 */}
      <div className="ls-pf-section">
        {!ncmUser ? (
          <div style={{ textAlign: 'center', padding: '10px 8px 4px' }}>
            <button className="ls-fm-refill" onClick={openLogin}>连接网易云账号</button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px' }}>
            <div className="ls-sec-h" style={{ padding: 0 }}>已连接 · {ncmUser}</div>
            <button className="ls-q-btn" onClick={doLogout} style={{ fontSize: 11, fontWeight: 500, padding: '3px 12px' }}>断开</button>
          </div>
        )}
      </div>

      {/* R9 歌单：点开进曲目面板（登录态 null=加载中 / 有数据=真实；未登录=空状态）*/}
      <div className="ls-pf-section">
        {ncmUser ? (
          ncmPlaylists === null ? (
            <div className="ls-empty"><div className="e-t">加载中…</div></div>
          ) : (
            <>
              <div className="ls-sec-h">歌单 {ncmPlaylists.length}</div>
              {ncmPlaylists.map(pl => (
                <div className="ls-pl-row" key={pl.id} onClick={() => openNcmPl(pl)}>
                  <div className="cv"><LSCover cover={pl.cover} size={120} radius={10} /></div>
                  <div className="si"><b>{pl.name}</b><i>{pl.count} 首{pl.mine ? ' · 我创建' : ''}</i></div>
                  <span className="play">{LSIcon.play({ width: 14, height: 14 })}</span>
                </div>
              ))}
            </>
          )
        ) : (
          <>
            <div className="ls-sec-h">歌单 {LS_PLAYLISTS.length}</div>
            {LS_PLAYLISTS.length ? LS_PLAYLISTS.map(p => (
              <div className="ls-pl-row" key={p.id} onClick={() => setOpenPl({ id: p.id, name: p.name, songs: p.songs || [] })}>
                <div className={'cv' + (p.heart ? ' heart' : '')}>
                  {p.heart ? <span className="ht"></span> : <LSCover cover={p.cover} size={120} radius={10} />}
                  {p.us && <span className="usbadge"></span>}
                </div>
                <div className="si"><b>{p.name}</b><i>{p.count} 首{p.us ? ' · 和 TA 共建' : ''}</i></div>
                <span className="play">{LSIcon.play({ width: 14, height: 14 })}</span>
              </div>
            )) : <div className="ls-empty"><div className="e-t">还没有歌单</div><div className="e-s">连接网易云账号后显示你的歌单</div></div>}
          </>
        )}
      </div>

      {/* R4 内联极简登录弹层 */}
            {login && (
        <div className="ls-ncm-mask" style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setLogin(false)}>
          <div className="ls-ncm-card" style={{ background: 'var(--ls-panel)', borderRadius: 16, padding: '22px 24px', textAlign: 'center', width: 'min(300px,86vw)' }} onClick={e => e.stopPropagation()}>
            <div className="ls-sec-h" style={{ padding: '0 0 12px' }}>扫码登录网易云</div>
            {qr && qr.qrimg
              ? <img src={qr.qrimg} alt="QR" style={{ width: 200, height: 200, borderRadius: 12, background: '#fff', padding: 8, boxSizing: 'border-box' }} />
              : <div className="ls-arc-sub" style={{ padding: '70px 0' }}>正在获取二维码…</div>}
            <div className="ls-arc-sub" style={{ marginTop: 12 }}>打开网易云音乐 App · 扫一扫登录</div>
            <button className="ls-q-btn" style={{ marginTop: 14 }} onClick={() => setLogin(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
// ════════════ 本地歌曲：粘贴音频直链自己加歌 ════════════
function LSLocalSongs({ backHead }) {
  const [list, setList] = v3UseState(function () { try { return JSON.parse(localStorage.getItem('ls-local-songs') || '[]'); } catch (e) { return []; } });
  const [url, setUrl] = v3UseState('');
  const [ti, setTi] = v3UseState('');
  const [ar, setAr] = v3UseState('');
  const save = (nl) => { setList(nl); try { localStorage.setItem('ls-local-songs', JSON.stringify(nl)); } catch (e) {} };
  const urlOk = /^https?:\/\//.test(url.trim());
  const add = () => {
    if (!urlOk) return;
    const u = url.trim();
    let guess = ''; try { guess = decodeURIComponent(u.split('/').pop().split('?')[0]).replace(/\.(mp3|m4a|flac|wav|ogg|aac)$/i, ''); } catch (e) {}
    save([{ id: 'loc_' + Date.now(), url: u, title: ti.trim() || guess || '本地歌曲', artist: ar.trim() || '', cover: '' }, ...list]);
    setUrl(''); setTi(''); setAr('');
  };
  const del = (id) => save(list.filter(x => x.id !== id));
  const play = (s, i) => { if (window.__lsPlayNcm) window.__lsPlayNcm(s, list, i); };
  return (
    <div className="ls-body ls-profile">{backHead('本地 · 自己加歌')}
      <div className="ls-localadd">
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="粘贴音频直链 URL（mp3 / m4a / flac…）" />
        <div className="row2">
          <input value={ti} onChange={e => setTi(e.target.value)} placeholder="歌名（可选）" />
          <input value={ar} onChange={e => setAr(e.target.value)} placeholder="歌手（可选）" />
        </div>
        <button className="addbtn" onClick={add} disabled={!urlOk}>添加到本地列表</button>
        <div className="tip">链接要能直接播放；添加后点歌名就能一起听、能分享进房间</div>
      </div>
      {list.length ? list.map((s, i) => (
        <div className="ls-songrow" key={s.id} onClick={() => play(s, i)}>
          <span className="no">{String(i + 1).padStart(2, '0')}</span>
          <div className="cv"><LSCover cover={s.cover} size={100} /></div>
          <div className="si"><b>{s.title}</b><i>{s.artist || '本地链接'}</i></div>
          <button className="locdel" onClick={(e) => { e.stopPropagation(); del(s.id); }} title="删除">×</button>
        </div>
      )) : <div className="ls-empty"><div className="e-t">还没有添加歌曲</div><div className="e-s">粘贴一条音频链接加进来</div></div>}
    </div>
  );
}

Object.assign(window, { LSBrowseView, LSPlaylistView, LSEdit, LSLocalSongs });
