/* listen/features2.jsx — E 模型设置 · F 私人FM · B 引用歌词问 Ta 抽屉。
   依赖 store.jsx、features.jsx（FIcon）。 */

const { useState: f2UseState, useRef: f2UseRef, useEffect: f2UseEffect } = React;

// ════════ F · 私人 FM 视图 ════════
function LSFMView({ onOpenSong, bump }) {
  const LSAPI = (typeof window !== 'undefined' && window.__LS_API) || '/api';
  const [synced, setSynced] = f2UseState('');
  const [logged, setLogged] = f2UseState(() => {
    const st = window.__ncmCache && window.__ncmCache.status;
    return st != null ? !!st.logged : false;
  });
  const [fm, setFm] = f2UseState(null);   // 登录态真实私人 FM（null=调频中）

  // 登录态探测
  f2UseEffect(() => {
    const st = window.__ncmCache && window.__ncmCache.status;
    if (st != null) { setLogged(!!st.logged); return; }
    if (window.__ncmStatus) window.__ncmStatus().then(d => { if (d && d.logged) setLogged(true); }).catch(() => {});
  }, []);

  // 登录后拉真实私人 FM：网易云一次通常只给一小批，播放器会在 FM 队列里继续补后面的未知歌曲。
  const loadFm = () => {
    return fetch(LSAPI + '/ncm/personal-fm').then(r => r.json())
      .then(d => { const songs = (d && d.songs) || []; setFm(songs); return songs; })
      .catch(() => { setFm([]); return []; });
  };
  f2UseEffect(() => { if (logged) { setFm(null); loadFm(); } }, [logged]);

  // 未登录不再展示演示 FM。
  const localFm = (window.__lsStore.fm || []).filter(x => !x.disliked);

  // 不喜欢 / 换一批：登录走真实网易云，未登录为空状态
  const dislikeReal = (it) => {
    fetch(LSAPI + '/ncm/fm-trash?id=' + encodeURIComponent(it.id), { method: 'POST' }).catch(() => {});
    setFm(list => (list || []).filter(x => x.id !== it.id));
    setSynced('已少推这类 · 已同步'); setTimeout(() => setSynced(''), 1800);
  };
  const dislikeLocal = (id) => { const s = window.__lsStore; const it = s.fm.find(x => x.id === id); if (it) it.disliked = true; lsSaveStore(s); setSynced('已少推这类 · 已同步'); setTimeout(() => setSynced(''), 1800); bump(); };
  const refillReal = () => { setSynced('换一批…'); setFm(null); loadFm().then(songs => { setSynced(songs.length ? '换了一批' : '暂时没有新歌'); setTimeout(() => setSynced(''), 1400); }); };
  const refillLocal = () => { const s = window.__lsStore; s.fm.forEach(x => x.disliked = false); lsSaveStore(s); setSynced('换了一批'); setTimeout(() => setSynced(''), 1500); bump(); };

  const playFm = (songs, i) => {
    if (window.__lsStartFm) { window.__lsStartFm(songs, i || 0); setSynced('已替换当前播放列表'); setTimeout(() => setSynced(''), 1400); }
    else if (window.__lsPlayNcm && songs && songs.length) window.__lsPlayNcm(songs[i || 0], songs, i || 0);
  };
  const play = (song, list, i) => { if (logged) playFm(list, i); else if (window.__lsPlayNcm) window.__lsPlayNcm(song, list, i); else if (onOpenSong) onOpenSong(song); };

  const list = logged ? fm : localFm;
  const openItem = (it, i) => { if (logged) play(it, list, i); else if (onOpenSong) onOpenSong(it); };
  const dislike = (it) => (logged ? dislikeReal(it) : dislikeLocal(it.id));
  const refill = logged ? refillReal : refillLocal;

  return (
    <div className="ls-body">
      <div className="ls-arc-head"><div className="ls-arc-h">私人 FM<span>电台为你和 TA 挑的 · 听满 30 秒会记得你的偏好</span></div></div>
      {synced && <div className="ls-fm-sync">♪ {synced}</div>}
      <div className="ls-fm-list">
        {!logged ? <LSEmpty t="连接网易云后使用私人 FM" s="也可以在曲库直接搜索歌曲" /> : list === null ? <LSEmpty t="调频中…" /> : list.length ? list.map((it, i) => (
          <div className="ls-fm-item" key={it.id}>
            <span className="no">{String(i + 1).padStart(2, '0')}</span>
            <div className="cv" onClick={() => openItem(it, i)}><LSCover id={it.cover} cover={it.cover} shape="rounded" radius="9" size={100} /></div>
            <div className="mid" onClick={() => openItem(it, i)}><b>{it.title}</b><i>{it.artist}</i></div>
            <button className="dis" title="不喜欢" onClick={() => dislike(it)}>{FIcon.dislike}</button>
          </div>
        )) : <LSEmpty t="这一批听完了" s="点下面换一批" />}
      </div>
      {logged && list && list.length ? <button className="ls-fm-refill" onClick={() => playFm(list, 0)}>播放私人 FM ▶</button> : null}
      {logged && <button className="ls-fm-refill" onClick={refill}>换一批 ↻</button>}
    </div>
  );
}

// ════════ B · 引用歌词 · 问 Ta 抽屉 ════════
function LSAskBar({ song, passage, onClear, onSaved }) {
  const [think, setThink] = f2UseState('');
  const [busy, setBusy] = f2UseState(false);
  const [reply, setReply] = f2UseState(null);
  const [usedChip, setUsedChip] = f2UseState(null);

  const run = async (chip) => {
    if (busy) return;
    setBusy(true); setReply(null); setUsedChip(chip ? chip.k : null);
    const out = await lsAskAI({ passage, think: think.trim(), chipPrompt: chip ? chip.prompt : '', song });
    setReply(out); setBusy(false);
    // 在场记录落库（挂在这首歌上；满 6 条服务端自动总结成"印象"）
    try {
      fetch((window.__LS_API || '/api') + '/song-note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: song.id, title: song.title, artist: song.artist || '', passage: passage || '', thought: think.trim(), reply: out }) }).catch(function () {});
    } catch (e) {}
    // 问答同时进房间时间线（回房间就能看到这段）
    try {
      if (window.__LS_SYNC && window.__LS_SYNC.send) {
        const d0 = new Date(); const tm = (d0.getHours() < 10 ? '0' : '') + d0.getHours() + ':' + (d0.getMinutes() < 10 ? '0' : '') + d0.getMinutes();
        const qBody = (think.trim() || (chip ? chip.prompt : '')).trim();
        if (qBody || passage) window.__LS_SYNC.send({ t: 'chat', msg: { who: 'eve', t: qBody, quote: passage || undefined, qsong: (song && song.title) || undefined, time: tm } });
        if (out) String(out).split(/\n+/).map(function(x){ return x.trim(); }).filter(Boolean).forEach(function(seg){ window.__LS_SYNC.send({ t: 'chat', msg: { who: 'yu', t: seg, time: tm } }); });
      }
    } catch (e) {}
    // 写入档案
    const s = window.__lsStore;
    s.archive.unshift({ id: 'a' + Date.now(), songId: song.id, title: song.title, artist: song.artist, cover: song.cover || '',
      passage, think: think.trim(), reply: out, model: (s.model && s.model.name) || 'AI', kind: 'both', ts: Date.now() });
    const li = s.library.find(x => x.songId === song.id); if (li) { li.notes += 1; li.last = Date.now(); }
    lsSaveStore(s); if (onSaved) onSaved();
  };

  return (
    <div className="ls-ask-mask" onClick={onClear}>
      <div className="ls-ask" onClick={e => e.stopPropagation()}>
        <div className="ls-ask-grip"></div>
        <div className="ls-ask-passage">“{passage}”<span className="src">{song.title} · {song.artist}</span></div>

        {reply && (
          <div className="ls-ask-reply">
            <span className="who">{FIcon.AI} {(window.LS_PEOPLE && window.LS_PEOPLE.yu && window.LS_PEOPLE.yu.name) || 'TA'}</span>
            <p style={{ whiteSpace: 'pre-line' }}>{reply}</p>
            <div className="done">已记进听歌档案 ✓</div>
          </div>
        )}

        {!reply && (
          <>
            <div className="ls-ask-chips">
              {LS_ASK_CHIPS.map(c => (
                <button key={c.k} className={'chip' + (usedChip === c.k ? ' on' : '')} disabled={busy} onClick={() => run(c)}>{c.label}</button>
              ))}
            </div>
            <div className="ls-ask-input">
              <input value={think} onChange={e => setThink(e.target.value)} placeholder="或者，写下你的想法…" disabled={busy}
                onKeyDown={e => e.key === 'Enter' && run(null)} />
              <button className="send" disabled={busy} onClick={() => run(null)}>
                {busy ? <span className="dots"><i></i><i></i><i></i></span> : LSIcon.next()}
              </button>
            </div>
            {busy && <div className="ls-ask-busy">正在回应…</div>}
          </>
        )}

        {reply && <button className="ls-ask-again" onClick={onClear}>好</button>}
      </div>
    </div>
  );
}

Object.assign(window, { LSFMView, LSAskBar, LSModelInline });

// ════════ E（内嵌版）· 一起听 tab 里的模型设置 ════════
function LSModelInline({ bump }) {
  const m0 = window.__lsStore.model || {};
  const c0 = m0.chat || {};
  const a0 = m0.analysis || {};
  const [cName, setCName] = f2UseState(c0.name || '');
  const [cEndpoint, setCEndpoint] = f2UseState(c0.endpoint || '');
  const [cKey, setCKey] = f2UseState(c0.key || '');
  const [cShow, setCShow] = f2UseState(false);
  const [aName, setAName] = f2UseState(a0.name || '');
  const [aEndpoint, setAEndpoint] = f2UseState(a0.endpoint || '');
  const [aKey, setAKey] = f2UseState(a0.key || '');
  const [aShow, setAShow] = f2UseState(false);
  const [persona, setPersona] = f2UseState(window.__lsStore.persona || '');
  const [styleTxt, setStyleTxt] = f2UseState(window.__lsStore.style || '');
  const [userNick, setUserNick] = f2UseState((function(){try{return localStorage.getItem('ls-nick-user')||'';}catch(e){return '';}})());
  const [aiNick, setAiNick] = f2UseState((function(){try{return localStorage.getItem('ls-nick-ai')||'';}catch(e){return '';}})());
  const [state, setState] = f2UseState('idle');
  // 拉取模型列表：POST /api/models {base_url, api_key} → 点选填入模型名
  const [mList, setMList] = f2UseState(null);   // {which:'chat'|'analysis', list:[...]}
  const [mBusy, setMBusy] = f2UseState('');
  const [mErr, setMErr] = f2UseState(null);     // {which, msg}
  const pullModels = (which) => {
    const ep = which === 'chat' ? cEndpoint : aEndpoint;
    const key = which === 'chat' ? cKey : aKey;
    if (!ep) { setMErr({ which: which, msg: '先填中转地址' }); return; }
    setMBusy(which); setMErr(null); setMList(null);
    const API = (typeof window !== 'undefined' && window.__LS_API) || '/api';
    fetch(API + '/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_url: ep, api_key: key }) })
      .then(r => r.json())
      .then(d => {
        if (d && d.ok && d.models && d.models.length) setMList({ which: which, list: d.models });
        else setMErr({ which: which, msg: (d && d.error) || '拉取失败：列表为空' });
        setMBusy('');
      })
      .catch(e => { setMErr({ which: which, msg: '拉取失败：' + ((e && e.message) || e) }); setMBusy(''); });
  };
  const pullRow = (which, setName) => (
    <>
      <div className="ls-fld ls-pullrow">
        <button className="ls-pullbtn" disabled={mBusy === which} onClick={() => pullModels(which)}>{mBusy === which ? '拉取中…' : '拉取模型列表'}</button>
        {mErr && mErr.which === which ? <span className="perr">{mErr.msg}</span> : null}
      </div>
      {mList && mList.which === which && (
        <div className="ls-mlist">
          {mList.list.map(id => <button key={id} onClick={() => { setName(id); setMList(null); }}>{id}</button>)}
        </div>
      )}
    </>
  );
  const save = () => {
    setState('saving');
    setTimeout(() => {
      try {
        const s = window.__lsStore;
        s.model = {
          chat: { name: cName, endpoint: cEndpoint, key: cKey },
          analysis: { name: aName, endpoint: aEndpoint, key: aKey }
        };
        s.persona = persona;
        s.style = styleTxt;
        try { localStorage.setItem('ls-nick-user', userNick); localStorage.setItem('ls-nick-ai', aiNick); if (window.LS_PEOPLE) { window.LS_PEOPLE.eve.name = userNick || 'You'; window.LS_PEOPLE.yu.name = aiNick || 'AI'; } } catch (e) {}
        lsSaveStore(s); setState('ok'); bump && bump(); setTimeout(() => setState('idle'), 1600);
      } catch (e) { setState('err'); }
    }, 700);
  };
  const eye = (show, toggle) => (
    <button className="eye" onClick={toggle} title="显示/隐藏">
      {show
        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.8 2.8M9.4 5.2A9.7 9.7 0 0 1 12 5c6 0 9 7 9 7a13 13 0 0 1-2.4 3.2M6.1 6.2A13 13 0 0 0 3 12s3 7 9 7a9 9 0 0 0 3-.5"/></svg>
        : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.6"/></svg>}
    </button>
  );
  return (
    <div className="ls-modelinline">
      <div className="ls-arc-head"><div className="ls-arc-h">模型设置<span>一起听陪聊回复 · 分析歌曲 双模型</span></div></div>

      <div className="ls-model-group">
        <div className="ls-model-gh">昵称设置（替换档案/房间里的名字）</div>
        <div className="ls-fld"><label>你的昵称</label>
          <input value={userNick} onChange={e => setUserNick(e.target.value)} placeholder="You" /></div>
        <div className="ls-fld"><label>AI 昵称</label>
          <input value={aiNick} onChange={e => setAiNick(e.target.value)} placeholder="AI" /></div>
      </div>

      <div className="ls-model-group">
        <div className="ls-model-gh">一起听陪聊回复模型</div>
        <div className="ls-fld"><label>回应模型</label>
          <input value={cName} onChange={e => setCName(e.target.value)} placeholder="claude-3-5-sonnet" /></div>
        <div className="ls-fld"><label>中转地址</label>
          <input value={cEndpoint} onChange={e => setCEndpoint(e.target.value)} placeholder="https://api.anthropic.com" /></div>
        <div className="ls-fld"><label>回应 Key</label>
          <div className="ls-keyrow">
            <input type={cShow ? 'text' : 'password'} value={cKey} onChange={e => setCKey(e.target.value)} placeholder="sk-…" />
            {eye(cShow, () => setCShow(s => !s))}
          </div></div>
        {pullRow('chat', setCName)}
      </div>

      <div className="ls-model-group">
        <div className="ls-model-gh">分析歌曲模型（通常填 gemini）</div>
        <div className="ls-fld"><label>回应模型</label>
          <input value={aName} onChange={e => setAName(e.target.value)} placeholder="google/gemini-2.5-flash" /></div>
        <div className="ls-fld"><label>中转地址</label>
          <input value={aEndpoint} onChange={e => setAEndpoint(e.target.value)} placeholder="https://api.anthropic.com" /></div>
        <div className="ls-fld"><label>回应 Key</label>
          <div className="ls-keyrow">
            <input type={aShow ? 'text' : 'password'} value={aKey} onChange={e => setAKey(e.target.value)} placeholder="sk-…" />
            {eye(aShow, () => setAShow(s => !s))}
          </div></div>
        {pullRow('analysis', setAName)}
      </div>

      <div className="ls-model-group">
        <div className="ls-model-gh">AI 人设 / 提示词</div>
        <div className="ls-fld"><label>AI 人设 / 提示词</label>
          <textarea className="ls-persona-ta" rows={5} value={persona} onChange={e => setPersona(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', display: 'block', margin: 0, padding: '10px 14px', borderRadius: '12px', border: '1px solid var(--ls-line)', background: 'color-mix(in srgb, var(--ls-panel) 15%, #fff)', color: 'var(--ls-ink)', fontSize: '14px', fontFamily: 'var(--ls-meta)', lineHeight: '1.5', resize: 'vertical', minHeight: '96px' }}
            placeholder="你是一个温柔的音乐伙伴，会根据心情推荐歌。想放歌时可以直接点歌。" /></div>
        <div className="ls-fld"><label>对话风格</label>
          <textarea rows={3} value={styleTxt} onChange={e => setStyleTxt(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', display: 'block', margin: 0, padding: '10px 14px', borderRadius: '12px', border: '1px solid var(--ls-line)', background: 'color-mix(in srgb, var(--ls-panel) 15%, #fff)', color: 'var(--ls-ink)', fontSize: '14px', fontFamily: 'var(--ls-meta)', lineHeight: '1.5', resize: 'vertical', minHeight: '64px' }}
            placeholder="TA 说话的方式：比如 回复简短像聊微信、多用语气词、别用书面腔。留空用默认。" /></div>
      </div>

      <button className={'ls-save ' + state} onClick={save} disabled={state === 'saving'}>
        {state === 'idle' && '保存'}{state === 'saving' && '保存中…'}{state === 'ok' && '已保存 ✓'}{state === 'err' && '保存失败，重试'}
      </button>
      <div className="ls-model-note">Key 只存在本地浏览器；陪聊模型用于一起听时 AI 回复，分析模型用于真听一遍歌。</div>
    </div>
  );
}
