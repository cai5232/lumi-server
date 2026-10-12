/* listen/features.jsx — A 歌曲详情抽屉 · C 听歌档案 · D 我们的歌库。
   依赖 store.jsx（lsLoadStore/lsSaveStore）、widgets.jsx（LSIcon）。
   FIcon、LSEmpty 在此定义，供 features2.jsx 复用。 */

const { useState: fUseState, useRef: fUseRef, useEffect: fUseEffect } = React;

// ── 图标（JSX 元素，直接 {FIcon.x} 使用）──────────────────
const _sv = (d, fill) => <svg viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={d}/></svg>;
const FIcon = {
  AI: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l2 4.5 4.9.5-3.7 3.3 1 4.8L12 13.8 7.8 16.1l1-4.8L5.1 8l4.9-.5z"/></svg>,
  heart: _sv('M12 21s-7.5-4.6-10-9.2C.4 8.6 2 5 5.4 5c2 0 3.3 1.1 4.1 2.3C10.3 6.1 11.6 5 13.6 5 17 5 18.6 8.6 17 11.8 14.5 16.4 12 21 12 21z'),
  heartFill: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-10-9.2C.4 8.6 2 5 5.4 5c2 0 3.3 1.1 4.1 2.3C10.3 6.1 11.6 5 13.6 5 17 5 18.6 8.6 17 11.8 14.5 16.4 12 21 12 21z"/></svg>,
  add: _sv('M12 5v14M5 12h14'),
  check: _sv('M5 12l5 5L20 6'),
  comment: _sv('M4 5h16v11H9l-4 4z'),
  pin: _sv('M9 3h6l-1 6 3 3v2h-5v5l-1 2-1-2v-5H4v-2l3-3z'),
  trash: _sv('M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13'),
  dislike: _sv('M14 4v9M14 8h4.5a1.5 1.5 0 0 1 1.4 2l-2 6a1.5 1.5 0 0 1-1.4 1H8V8l3-5a2 2 0 0 1 2 2zM8 8H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3'),
  close: _sv('M6 6l12 12M18 6L6 18'),
  play: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>,
};

// ── 空态 ────────────────────────────────────────────────
function LSEmpty({ t, s }) {
  return (
    <div className="ls-empty">
      <div className="e-ic">♪</div>
      <div className="e-t">{t}</div>
      {s && <div className="e-s">{s}</div>}
    </div>
  );
}

// 一条在场记录卡（档案 & 抽屉「在场记录」tab 复用）
function LSArcCard({ rec, compact, onOpen }) {
  return (
    <div className={'ls-arc-card' + (compact ? ' compact' : '')} onClick={onOpen ? () => onOpen(rec.songId) : undefined}>
      {!compact && (
        <div className="ls-arc-song">
          <div className="cv"><LSCover cover={rec.cover} size={120} shape="rounded" radius={8} /></div>
          <div className="si"><b>{rec.title}</b><i>{rec.artist}</i></div>
          <span className="ts">{(window.lsFmtTs || String)(rec.ts)}</span>
        </div>
      )}
      {rec.passage && <div className="ls-arc-passage">{rec.passage}</div>}
      {rec.think && <div className="ls-arc-think"><span className="who">{(window.LS_PEOPLE && window.LS_PEOPLE.eve.name) || '我'}</span>{rec.think}</div>}
      {rec.reply && (
        <div className="ls-arc-reply">
          <span className="who">{FIcon.AI} {(window.LS_PEOPLE && window.LS_PEOPLE.yu.name) || 'AI'}</span>
          <p>{rec.reply}</p>
        </div>
      )}
      {compact && <div className="ls-arc-ts">{(window.lsFmtTs || String)(rec.ts)}</div>}
    </div>
  );
}

function lsNotesToRecs(rows) {
  return (rows || []).map(function (n, i) {
    return { id: 'sn' + (n.ts || 0) + '_' + i, songId: String(n.song_id || ''), title: n.title || '', artist: n.artist || '', cover: n.cover || '', passage: n.passage || '', think: n.thought || '', reply: n.reply || '', ts: n.ts };
  });
}

// ════════ A. 歌曲详情抽屉 ════════
function LSSongDrawer({ song: songProp, ncmSong, ncmId, loved, onToggleLove, inLibrary, onAddLibrary, onAskAI, onClose }) {
  const song = ncmSong || songProp;
  const [tab, setTab] = fUseState('present');     // present | lyric | ncm | local
  const [drag, setDrag] = fUseState(0);
  const [qToast, setQToast] = fUseState('');
  const startY = fUseRef(null);
  const [ncmC, setNcmC] = fUseState(null);
  const [ana, setAna] = fUseState('');
  fUseEffect(() => { let on = true; setAna(''); if (song && song.id && /^\d+$/.test(String(song.id))) { fetch((window.__LS_API || '/api') + '/song-analysis?id=' + song.id).then(r => r.json()).then(d => { if (on && d && d.ok) { const parts = []; if (d.impression) parts.push('【这首歌的回忆】\n' + d.impression); if (d.text) parts.push('【听感分析】\n' + d.text); setAna(parts.join('\n\n')); } }).catch(() => {}); } return () => { on = false; }; }, [song && song.id]);
  const localArc = (window.__lsStore.archive || []).filter(a => a.songId === song.id);
  const [srvArc, setSrvArc] = fUseState(null);
  fUseEffect(() => { let on = true; if (song && song.id && /^\d+$/.test(String(song.id))) { fetch((window.__LS_API || '/api') + '/song-notes?id=' + song.id).then(r => r.json()).then(d => { if (on && d && d.ok) setSrvArc(lsNotesToRecs(d.notes)); }).catch(() => {}); } return () => { on = false; }; }, [song && song.id]);
  const archive = (srvArc !== null) ? srvArc : localArc;

  const down = e => { startY.current = (e.touches ? e.touches[0].clientY : e.clientY); };
  const move = e => { if (startY.current == null) return; const y = (e.touches ? e.touches[0].clientY : e.clientY); const d = y - startY.current; if (d > 0) setDrag(d); };
  const up = () => { if (drag > 100) { onClose(); } setDrag(0); startY.current = null; };

  const realId = ncmId || (/^\d+$/.test(String(song.id)) ? song.id : null);
  fUseEffect(() => {
    setNcmC(null);
    if (tab === 'ncm' && realId) {
      let on = true;
      fetch((window.__LS_API || '/api') + '/ncm/comments?id=' + realId)
        .then(r => r.json())
        .then(d => { if (on) setNcmC(d.comments || []); })
        .catch(() => {});
      return () => { on = false; };
    }
  }, [tab, realId]);

  return (
    <div className="ls-drawer-mask" onClick={onClose}>
      <div className="ls-drawer" style={drag ? { transform: 'translateY(' + drag + 'px)' } : null} onClick={e => e.stopPropagation()}>
        <div className="ls-drawer-grip" onMouseDown={down} onMouseMove={move} onMouseUp={up}
          onTouchStart={down} onTouchMove={move} onTouchEnd={up}><span></span></div>

        <div className="ls-dr-head">
          <div className="ls-dr-cover"><LSCover cover={song.cover} size={400} shape="rounded" radius={14} /></div>
          <div className="ls-dr-meta">
            <div className="t">{song.title}</div>
            <div className="a">{song.artist} · {song.album}</div>
            <div className="badges"><span className="bd vip">VIP</span><span className="bd play">可播放</span></div>
          </div>
          <button className="ls-dr-x" onClick={onClose}>{FIcon.close}</button>
        </div>

        {qToast && <div className="ls-dr-toast">{qToast}</div>}
        <div className="ls-dr-actions">
          <button className="act" onClick={() => { if (window.__lsPlayNcm) window.__lsPlayNcm(song); }}><span className="ic">{FIcon.play}</span>播放</button>
          <button className="act" onClick={() => { if (window.__lsQueueAppend) window.__lsQueueAppend([song]); setQToast('已加入播放列表'); setTimeout(() => setQToast(''), 1500); }}><span className="ic">{FIcon.add}</span>加入列表</button>
          <button className="act" onClick={onToggleLove}><span className="ic" style={loved ? { color: '#e6455f' } : null}>{loved ? FIcon.heartFill : FIcon.heart}</span>红心</button>
          <button className="act" onClick={() => onAskAI(song, song.tag)}><span className="ic">{FIcon.AI}</span>问 Ta</button>
        </div>

        <div className="ls-dr-tabs">
          {[['present', '在场记录'], ['lyric', '歌曲分析'], ['ncm', '网易评论'], ['local', '本地信息']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>

        <div className="ls-dr-body">
          {tab === 'present' && (archive.length
            ? <div className="ls-arc-list">{archive.map(a => <LSArcCard key={a.id} rec={a} compact />)}</div>
            : <LSEmpty t="还没有在场记录" s="点「问 Ta」或在歌词页引用一句，开始第一条" />)}

          {tab === 'lyric' && (<div>
            {ana
              ? <div className="ls-dr-ana" style={{ whiteSpace: 'pre-line' }}>{ana}</div>
              : <LSEmpty t="还没认真听过这首" s="放着它进房间聊聊、或点「问 Ta」，就会真的听一遍写下来" />}
            {(song.lyrics && song.lyrics.length) ? <div className="ls-dr-lyrics">
              {song.lyrics.map((l, i) => {
                const t = l.line.replace(/[（(].*?[)）]/g, '').trim();
                const askable = t && !/^[·\s]+$/.test(t);
                return <div key={i} className="ll" style={askable ? { cursor: 'pointer' } : null}
                  onClick={() => askable && onAskAI(song, t)}>{l.line}</div>;
              })}
              <div className="ls-empty" style={{ padding: '16px 0 0' }}><div className="e-s">点任意一句 → 引用给 TA</div></div>
            </div> : null}
          </div>)}

          {tab === 'ncm' && (
            <div className="ls-dr-ncm">
              {!realId
                ? <LSEmpty t="暂无网易评论" s="播放网易云歌曲后可见热评" />
                : ncmC === null
                  ? <div className="ls-empty" style={{ padding: '24px 0' }}><div className="e-s">加载中…</div></div>
                  : ncmC.map((c, i) => (
                    <div className="nc" key={i}>
                      <div className="av"><img src={c.av} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /></div>
                      <div className="m"><b>{c.u}</b><p>{c.t}</p><span className="z">♡ {c.z}</span></div>
                    </div>
                  ))}
            </div>
          )}

          {tab === 'local' && (
            <div className="ls-dr-local">
              <div className="row"><span className="k">来源</span><span className="v">网易云音乐</span></div>
              <div className="row"><span className="k">专辑</span><span className="v">{song.album}</span></div>
              <div className="row"><span className="k">时长</span><span className="v">{lsFmt(song.dur)}</span></div>
              <div className="row"><span className="k">音质</span><span className="v">无损 · FLAC</span></div>
              <div className="row"><span className="k">在场记录</span><span className="v">{archive.length} 条</span></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════ C. 听歌档案 ════════
function LSArchiveView({ onOpenSong }) {
  // 过滤旧版出厂占位（s1-s4）的记录，只显示真实的问Ta记录
  const localList = (window.__lsStore.archive || []).filter(function (a) { return !/^s\d$/.test(String((a && a.songId) || '')); });
  const [srvList, setSrvList] = fUseState(null);
  fUseEffect(function () { fetch((window.__LS_API || '/api') + '/song-notes?limit=100').then(function (r) { return r.json(); }).then(function (d) { if (d && d.ok) setSrvList(lsNotesToRecs(d.notes || [])); }).catch(function () {}); }, []);
  const list = srvList || localList;
  const f = list;
  // 真实听歌档案：服务端聚合（总量 / 时段偏好 / 常听排行 + 每首的听后印象）
  const [stats, setStats] = fUseState(null);
  fUseEffect(function () {
    fetch((window.__LS_API || '/api') + '/listen-stats').then(function (r) { return r.json(); }).then(function (d) { if (d && d.ok) setStats(d); }).catch(function () {});
  }, []);
  const fmtDay = function (ts) { try { const d = new Date(ts); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; } catch (e) { return ''; } };
  const topBucket = (stats && stats.buckets) ? Object.entries(stats.buckets).sort(function (a, b) { return b[1] - a[1]; })[0] : null;
  return (
    <div className="ls-body">
      <div className="ls-arc-head">
        <div className="ls-arc-h">听歌档案</div>
        <div className="ls-arc-sub">{stats && stats.total ? ('一起听过 ' + stats.total + ' 次 · ' + stats.distinct + ' 首歌' + (topBucket ? (' · 最常在' + topBucket[0] + '听') : '')) : ('在场记录 · 最近 ' + list.length + ' 条')}</div>
      </div>
      {f.length
        ? <div className="ls-arc-list">{f.map(a => <LSArcCard key={a.id} rec={a} onOpen={onOpenSong} />)}</div>
        : <LSEmpty t="还没有记录" s="放几首歌、或去歌词页问问 Ta" />}
    </div>
  );
}

// ════════ D. 我们的歌库 ════════
function LSLibraryView({ onOpenSong, bump }) {
  const [, setTick] = fUseState(0);
  const refresh = () => { lsSaveStore(window.__lsStore); setTick(t => t + 1); bump && bump(); };
  const list = (window.__lsStore.library || []).slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  const pin = (songId) => { const it = window.__lsStore.library.find(x => x.songId === songId); if (it) it.pinned = !it.pinned; refresh(); };
  const del = (songId) => { window.__lsStore.library = window.__lsStore.library.filter(x => x.songId !== songId); refresh(); };

  return (
    <div className="ls-body">
      <div className="ls-arc-head">
        <div className="ls-arc-h">我们的歌库</div>
        <div className="ls-arc-sub">{list.length} 首 · 共同收藏 · 置顶/删除</div>
      </div>
      {list.length ? (
        <div className="ls-lib-list">
          {list.map(it => (
            <div className={'ls-lib-item' + (it.pinned ? ' pinned' : '')} key={it.songId}>
              <div className="cv" onClick={() => onOpenSong(it.songId)}>
                <LSCover cover={it.cover} size={120} shape="rounded" radius={9} />
                {it.pinned && <span className="pinbadge">{FIcon.pin}</span>}
              </div>
              <div className="mid" onClick={() => onOpenSong(it.songId)}>
                <b>{it.title}</b>
                <div className="sub"><span>{it.artist}</span><span className="dot"></span><span>{it.notes} 条记录</span><span className="dot"></span><span>{(window.lsFmtTs || String)(it.last)}</span></div>
              </div>
              <div className="ops">
                <button className={it.pinned ? 'on' : ''} onClick={() => pin(it.songId)} title="置顶">{FIcon.pin}</button>
                <button onClick={() => del(it.songId)} title="删除">{FIcon.trash}</button>
              </div>
            </div>
          ))}
        </div>
      ) : <LSEmpty t="还没有收进我们的歌库" s="在歌曲详情里点「收进歌库」" />}
    </div>
  );
}

Object.assign(window, { FIcon, LSEmpty, LSSongDrawer, LSArchiveView, LSLibraryView, LSArcCard });
