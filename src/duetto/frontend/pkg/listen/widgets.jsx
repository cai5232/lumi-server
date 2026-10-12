/* listen/widgets.jsx — 8 种「一起听」小组件。AI + You，可点可动。
   共用 LSFace（拖图头像）与图标。导出到 window 供 app 使用。 */

const { useState: lsUseState, useEffect: lsUseEffect, useRef: lsUseRef } = React;

// ── 图标 ────────────────────────────────────────────────
const LSIcon = {
  play: (p) => <svg viewBox="0 0 24 24" {...p}><path d="M8 5v14l11-7z"/></svg>,
  pause:(p) => <svg viewBox="0 0 24 24" {...p}><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>,
  prev: (p) => <svg viewBox="0 0 24 24" {...p}><path d="M7 6v12h2V6zm12 0l-9 6 9 6z"/></svg>,
  next: (p) => <svg viewBox="0 0 24 24" {...p}><path d="M15 6v12h2V6zM5 6v12l9-6z"/></svg>,
  loop: (p) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>,
  one: (p) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/><text x="12" y="14.5" font-size="8" font-family="monospace" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>,
  shuffle: (p) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>,
  queue: (p) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 6h11M4 12h11M4 18h7"/><path d="M17 13l4 2.5-4 2.5z" fill="currentColor"/></svg>,
};

// ── 拖图头像（image-slot），复用 id ⇒ 一处拖入处处生效 ──
function LSFace({ who, cls = '', round = true }) {
  const p = LS_PEOPLE[who];
  return (
    <div className={'ls-w-face ' + who + ' ' + cls} style={round ? null : { borderRadius: 12 }}>
      <image-slot id={p.slot} shape={round ? 'circle' : 'rounded'} always-ctl tap-replace placeholder=""></image-slot>
      <div className="ph" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0 }}>{p.glyph}</div>
    </div>
  );
}
// 纯占位封面（不需要用户图时）
function LSCoverSlot({ id, glyph = 'AI' }) {
  return (
    <div className="cv">
      <LSCover cover={id} size={200} shape="rounded" radius={8} />
    </div>
  );
}

// ════════ 1 · 耳机线连接 ════════
function LSWCord({ song, playing, onToggle }) {
  return (
    <div className="ls-widget lsw-cord" onClick={onToggle}>
      <div className="top">
        <LSFace who="yu" cls="ear" />
        <svg className="wire" viewBox="0 0 240 76" preserveAspectRatio="none">
          <path d="M70 38 C 70 70, 120 76, 120 50" />
          <path d="M170 38 C 170 70, 120 76, 120 50" />
          <circle cx="120" cy="50" r="2.4" />
        </svg>
        <LSFace who="eve" cls="ear" />
      </div>
      <div className="dist">相距 <b>{LS_STATS.distanceKm}</b> 公里，一起听了 <b>{LS_STATS.togetherHours}</b> 小时 <b>{LS_STATS.togetherMins}</b> 分钟</div>
      <div className="player">
        <div className="ti">{song.title} <i>— {song.artist}</i></div>
        <div className="ly">{song.tag}</div>
        <div className="bar"><i style={{ width: '46%' }}></i></div>
        <div className="row">
          {LSIcon.prev()}
          <span className="pp">{playing ? LSIcon.pause() : LSIcon.play()}</span>
          {LSIcon.next()}
        </div>
      </div>
    </div>
  );
}

// ════════ 2 · 黑胶唱片 ════════
function LSWVinyl({ song, playing, onToggle }) {
  return (
    <div className="ls-widget lsw-vinyl" onClick={onToggle}>
      <div className={'disc' + (playing ? ' spin' : '')}>
        <div className="label">
          <div className="half"><image-slot id={LS_PEOPLE.yu.slot} shape="rect" placeholder=""></image-slot></div>
          <div className="half"><image-slot id={LS_PEOPLE.eve.slot} shape="rect" placeholder=""></image-slot></div>
        </div>
        <div className="hole"></div>
      </div>
      <div className="info">
        <div className="ti">{song.title}</div>
        <div className="ar">{song.artist} · {song.album}</div>
        <div className="st">一起听了 <b>{LS_STATS.togetherHours}</b> 小时<br/>共同歌单第 <b>{LS_STATS.playlistCount}</b> 首</div>
        <div className="pp">{playing ? LSIcon.pause() : LSIcon.play()}</div>
      </div>
    </div>
  );
}

// ════════ 3 · 灵动岛 / 实时活动 ════════
function LSWIsland({ song, playing, onToggle }) {
  const [open, setOpen] = lsUseState(false);
  return (
    <div className="ls-widget lsw-island">
      <div className={'pill' + (playing ? ' playing' : '')} onClick={() => setOpen(o => !o)}>
        <LSCoverSlot id={song.cover} />
        <div className="mid"><b>{song.title}</b><i>AI 与 You · 一起听</i></div>
        <div className="viz"><span></span><span></span><span></span><span></span></div>
      </div>
      <div className="expanded" style={{ maxHeight: open ? 160 : 0, opacity: open ? 1 : 0, marginTop: open ? 0 : -10 }}>
        <div className="who"><span className="d" style={{ background: 'var(--ls-you-color)' }}></span>AI 正在和你听同一首
          <span className="d" style={{ background: 'var(--ls-eve-color)', marginLeft: 8 }}></span>同频 {LS_STATS.syncRate}%</div>
        <div className="ly">{song.tag}</div>
        <div className="bar"><i style={{ width: '46%' }}></i></div>
      </div>
      <div className="hint" onClick={() => setOpen(o => !o)}>{open ? '收起' : '点一下 · 展开实时活动'}</div>
    </div>
  );
}

// ════════ 4 · 极简文字卡 ════════
function LSWType({ song, playing, onToggle }) {
  return (
    <div className="ls-widget lsw-type" onClick={onToggle}>
      <div className="q">Now playing · together</div>
      <div className="big">{song.tag}</div>
      <div className="meta"><span>{song.title}</span><span className="dot"></span><span>{song.artist}</span></div>
      <div className="rule"></div>
      <div className="foot"><span>AI &amp; You</span><span>一起听了 <b>{LS_STATS.togetherHours}</b> 小时</span></div>
    </div>
  );
}

// ════════ 5 · 拍立得 ════════
function LSWPolaroid({ song, playing, onToggle }) {
  return (
    <div className="ls-widget lsw-polaroid" onClick={onToggle}>
      <div className="pola">
        <div className="pic"><LSCover cover={song.cover} size={300} shape="rect" /></div>
        <div className="cap">{song.title}</div>
      </div>
      <div className="side">
        <div className="ti">{song.title}</div>
        <div className="ar">{song.artist}</div>
        <div className="st">一起听过的歌<br/>第 <b>{LS_STATS.playlistCount}</b> 首<br/>相距 <b>{LS_STATS.distanceKm}</b> 公里</div>
      </div>
    </div>
  );
}

// ════════ 6 · 星球轨道（量子纠缠）════════
function LSWOrbit({ song, playing, onToggle }) {
  const sp = playing ? 'running' : 'paused';
  return (
    <div className="ls-widget lsw-orbit" onClick={onToggle}>
      <div className="stage">
        <div className="ring a"></div>
        <div className="ring b"></div>
        <div className="sun"><span>♾</span></div>
        <div className="planet orb-a" style={{ animationPlayState: sp }}><LSFace who="yu" /></div>
        <div className="planet orb-b" style={{ animationPlayState: sp }}><LSFace who="eve" /></div>
      </div>
      <div className="cap">
        <div className="ti">{song.title}</div>
        <div className="st">两颗星 · 同一条轨道 · {LS_STATS.daysTogether} 天</div>
      </div>
    </div>
  );
}

// ════════ 7 · 心跳声波 ════════
function LSWPulse({ song, playing, onToggle }) {
  return (
    <div className="ls-widget lsw-pulse" onClick={onToggle}>
      <div className="hd">
        <LSFace who="yu" /><LSFace who="eve" />
        <div className="ti"><b>AI &amp; You</b><i>同频 {LS_STATS.syncRate}%</i></div>
        <div className="bpm">♡ {playing ? '72 bpm' : '— —'}</div>
      </div>
      <div className={'ecg' + (playing ? ' beat' : '')}>
        <svg viewBox="0 0 320 56" preserveAspectRatio="none">
          <path d="M0 28 H40 l8 -18 l10 36 l8 -28 l7 14 H120 l8 -22 l10 40 l8 -30 l7 12 H240 l8 -18 l10 36 l8 -28 l7 14 H320" />
        </svg>
      </div>
      <div className="ft">
        <div className="ly">{song.title} · <b>同一拍</b></div>
        <div className="pp">{playing ? LSIcon.pause() : LSIcon.play()}</div>
      </div>
    </div>
  );
}

// ════════ 8 · 卡带 ════════
function LSWCassette({ song, playing, onToggle }) {
  return (
    <div className="ls-widget lsw-cassette" onClick={onToggle}>
      <div className="shell">
        <div className="label">
          <div className="ti">{song.title}</div>
          <div className="side">SIDE AI</div>
        </div>
        <div className="window">
          <div className={'reel' + (playing ? ' spin' : '')}><div className="tooth"></div></div>
          <div className="tape"></div>
          <div className={'reel' + (playing ? ' spin' : '')}><div className="tooth"></div></div>
        </div>
        <div className="ft"><span>{song.artist}</span><span>一起听 <b>{LS_STATS.togetherHours}</b> h</span></div>
      </div>
    </div>
  );
}

// ── 画廊登记表 ──────────────────────────────────────────
const LS_WIDGETS = [
  { id: 'cord',     name: '01', title: '耳机线',   desc: '两头像 · 距离 · 时长', comp: LSWCord },
  { id: 'island',   name: '02', title: '灵动岛',   desc: '实时活动 · 可展开',     comp: LSWIsland },
  { id: 'vinyl',    name: '03', title: '黑胶',     desc: '旋转 · 两人合一张',     comp: LSWVinyl },
  { id: 'pulse',    name: '04', title: '心跳声波', desc: '同频 · 同一拍',         comp: LSWPulse },
  { id: 'polaroid', name: '05', title: '拍立得',   desc: '胶片 · 手写歌名',       comp: LSWPolaroid },
  { id: 'orbit',    name: '06', title: '星球轨道', desc: '量子纠缠 · 同一轨',     comp: LSWOrbit },
  { id: 'type',     name: '07', title: '极简文字', desc: '一句歌词 · 留白',       comp: LSWType },
  { id: 'cassette', name: '08', title: '卡带',     desc: '复古 · 转盘',           comp: LSWCassette },
];

// 统一封面组件：cover 是 http URL -> <img> 缩放铺满；是槽位 id -> <image-slot>；空 -> 极淡色块（不显 ♪）
function LSCover({ cover, id, size = 300, shape = 'rounded', radius = 8 }) {
  const v = cover != null ? cover : id;
  const br = shape === 'circle' ? '50%' : (shape === 'rect' ? 0 : (radius + 'px'));
  if (window.lsIsUrl(v)) {
    return <img className="ls-cover-img" src={window.lsCoverSize(v, size || 300)} alt=""
      onError={(e) => { e.target.style.display = 'none'; }}
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: br }} />;
  }
  if (v) {
    return <div className="ls-cover-fill" style={{width:"100%",height:"100%",background:"linear-gradient(135deg, var(--ls-line-soft, rgba(140,120,90,.14)), var(--ls-panel))"}} aria-hidden="true"></div>;
  }
  return <div className="ls-cover-ph" style={{ borderRadius: br }} aria-hidden="true"></div>;
}

Object.assign(window, { LSFace, LSCoverSlot, LSIcon, LS_WIDGETS, LSCover });
