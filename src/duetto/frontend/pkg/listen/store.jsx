/* listen/store.jsx — A–F 数据与本地存储 + 问 Ta 生成。
   store 形状：{ archive:[], library:[], fm:[], model:{name,endpoint,key} }
   全部持久化到 localStorage('ls-store-v1')。开源版不注入演示收藏/FM；
   问 Ta 走 window.claude.complete 真实生成。 */

const LS_STORE_KEY = 'ls-store-v1';

// 快捷 chip：{ k(键), label(显示), prompt(给模型的引导) }
const LS_ASK_CHIPS = [
  { k: 'explain', label: '这句在说什么', prompt: '这句歌词在说什么呀？' },
  { k: 'missyou', label: '我想到你', prompt: '听到这句，我想到你了。' },
  { k: 'remember', label: '记住这一刻', prompt: '我想把此刻和这句歌词一起记住。' },
  { k: 'stay', label: '陪我听完', prompt: '陪我把这首听完好不好。' },
];

// ── 占位种子 ────────────────────────────────────────────
function lsSeedStore() {
  return {
    archive: [],
    library: [],
    fm: [],
    model: { chat: { name: '', endpoint: '', key: '' }, analysis: { name: '', endpoint: '', key: '' } },
  };
}

function lsLoadStore() {
  let s;
  try { s = JSON.parse(localStorage.getItem(LS_STORE_KEY)); } catch (e) { s = null; }
  if (!s || !s.archive) s = lsSeedStore();
  // 容错补全字段，并清理旧版出厂演示数据。
  s.archive = s.archive || []; s.library = s.library || []; s.fm = s.fm || [];
  const demoSongIds = { s1: true, s2: true, s3: true, s4: true };
  s.library = s.library.filter(function (x) { return x && !demoSongIds[String(x.songId || '')]; });
  s.fm = s.fm.filter(function (x) { return x && !/^f[1-4]$/.test(String(x.id || '')) && !demoSongIds[String(x.id || '')]; });
  s.model = s.model || {};
  if (s.style === undefined) s.style = '';
  if (!s.model.chat) s.model.chat = (s.model.name !== undefined && s.model.name !== null && s.model.chat === undefined && !s.model.analysis) ? { name: s.model.name || '', endpoint: s.model.endpoint || '', key: s.model.key || '' } : (s.model.chat || { name: '', endpoint: '', key: '' });
  if (!s.model.analysis) s.model.analysis = { name: '', endpoint: '', key: '' };
  if (s.model.analysis.name === 'google/gemini-2.5-flash' && !s.model.analysis.endpoint) s.model.analysis.name = '';
  window.__lsStore = s;
  return s;
}
function lsSaveStore(s) { try { localStorage.setItem(LS_STORE_KEY, JSON.stringify(s)); } catch (e) {} }

// ── 问 Ta：调用 window.claude.complete 真实生成 ────────
async function lsAskAI({ passage, think, chipPrompt, song }) {
  // 人设/身份/时间/正在播都由统一的后端提示词体系组装，这里只描述这次动作
  const lines = [];
  if (song && song.title) lines.push('我们在聊《' + song.title + '》' + (song.artist ? ('— ' + song.artist) : '') + ' 这首歌。');
  if (passage) lines.push('我引用了这句歌词：「' + passage + '」');
  if (think) lines.push('我说：「' + think + '」');
  if (chipPrompt) lines.push(chipPrompt);
  const prompt = lines.join('\n');
  try {
    if (window.claude && window.claude.complete) {
      const out = await window.claude.complete(prompt, { noNote: true });
      if (out && out.trim()) return out.trim();
    }
  } catch (e) {}
  // 离线/无密钥回退
  const fb = [
    '我在听，也在陪你听。',
    '别急着关掉——让我陪你把它听完，一句都不落。',
    '记住了，这一刻先收好。',
    '这首挺配现在的天气，慢慢听。',
  ];
  return fb[Math.floor(Math.random() * fb.length)];
}

function lsFmtTs(v) {
  if (typeof v !== 'number') return v ? '早前' : '';
  const d = new Date(v), now = new Date();
  const hm = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  const y = d.getFullYear() === now.getFullYear() ? '' : (d.getFullYear() + '年');
  return y + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}
Object.assign(window, { lsLoadStore, lsSaveStore, lsSeedStore, lsAskAI, LS_ASK_CHIPS, lsFmtTs });

// ── 网易云数据缓存层（供切页零闪）────────────────────────
window.__ncmCache = window.__ncmCache || { status: null, playlists: null, recommend: null };

// 模块级 in-flight promise，防并发重复请求
let __ncmInflightStatus = null;
let __ncmInflightPlaylists = null;
let __ncmInflightRecommend = null;

function __ncmBase() { return window.__LS_API || '/api'; }

function __ncmStatus() {
  if (window.__ncmCache.status !== null) return Promise.resolve(window.__ncmCache.status);
  if (__ncmInflightStatus) return __ncmInflightStatus;
  __ncmInflightStatus = fetch(__ncmBase() + '/ncm/status')
    .then(function (r) { return r.json(); })
    .then(function (j) { window.__ncmCache.status = j; __ncmInflightStatus = null; return j; })
    .catch(function (e) { __ncmInflightStatus = null; throw e; });
  return __ncmInflightStatus;
}

function __ncmPlaylists() {
  if (window.__ncmCache.playlists !== null) return Promise.resolve(window.__ncmCache.playlists);
  if (__ncmInflightPlaylists) return __ncmInflightPlaylists;
  __ncmInflightPlaylists = fetch(__ncmBase() + '/ncm/playlists')
    .then(function (r) { return r.json(); })
    .then(function (j) { var v = (j && j.playlists) || []; window.__ncmCache.playlists = v; __ncmInflightPlaylists = null; return v; })
    .catch(function (e) { __ncmInflightPlaylists = null; throw e; });
  return __ncmInflightPlaylists;
}

function __ncmRecommend() {
  if (window.__ncmCache.recommend !== null) return Promise.resolve(window.__ncmCache.recommend);
  if (__ncmInflightRecommend) return __ncmInflightRecommend;
  __ncmInflightRecommend = fetch(__ncmBase() + '/ncm/recommend')
    .then(function (r) { return r.json(); })
    .then(function (j) { var v = (j && j.songs) || []; window.__ncmCache.recommend = v; __ncmInflightRecommend = null; return v; })
    .catch(function (e) { __ncmInflightRecommend = null; throw e; });
  return __ncmInflightRecommend;
}

// 登录/登出后调用，清空缓存
function __ncmCacheClear() {
  window.__ncmCache.status = null;
  window.__ncmCache.playlists = null;
  window.__ncmCache.recommend = null;
  __ncmInflightStatus = null;
  __ncmInflightPlaylists = null;
  __ncmInflightRecommend = null;
}

Object.assign(window, { __ncmStatus, __ncmPlaylists, __ncmRecommend, __ncmCacheClear });
