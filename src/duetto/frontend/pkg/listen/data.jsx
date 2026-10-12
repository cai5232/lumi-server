/* listen/data.jsx — runtime defaults for the open/self-host build. No demo songs, chats, comments, or playlists are seeded. */

// —— 两个人 ——
const LS_PEOPLE = {
  yu:  { key: 'yu',  name: (function(){try{return localStorage.getItem('ls-nick-ai')||'AI';}catch(e){return 'AI';}})(),  latin: 'DJ', note: 'your listening companion', slot: 'ls-ava-yu',  glyph: 'AI' },
  eve: { key: 'eve', name: (function(){try{return localStorage.getItem('ls-nick-user')||'You';}catch(e){return 'You';}})(), latin: '',   note: 'turn every song into a story', slot: 'ls-ava-eve', glyph: 'U' },
};

const LS_EMPTY_SONG = {
  id: '',
  title: '还没有播放',
  artist: '',
  album: '',
  dur: 0,
  cover: '',
  tag: '登录网易云或在曲库搜索一首歌开始一起听',
  lyrics: [],
};

// 出厂不再注入假歌、假聊天、假评论、假歌单。
const LS_SONGS = [];
const LS_CHAT = [];
const LS_COMMENTS = [];
const LS_DANMU = [];
const LS_DAILY = [];
const LS_RECENT = [];
const LS_HOT = [];
const LS_PLAYLISTS = [];

// —— 一起听 · 统计（默认从 0 开始，可在歌单页 DIY）——
const LS_STATS = {
  distanceKm: '0',
  togetherHours: 0,
  togetherMins: 0,
  playlistCount: 0,
  daysTogether: 0,
  syncRate: 0,
};

// 把秒格式化成 m:ss
function lsFmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

// 封面 helper：lsIsUrl 判断 http(s) URL；lsCoverSize 给网易云图片加缩放参数
function lsIsUrl(v) { return typeof v === 'string' && /^https?:/.test(v); }
function lsCoverSize(url, px) {
  if (!lsIsUrl(url)) return url || '';
  px = px || 300;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'param=' + px + 'y' + px;
}

Object.assign(window, { LS_PEOPLE, LS_EMPTY_SONG, LS_SONGS, LS_CHAT, LS_COMMENTS, LS_DANMU, LS_STATS, LS_DAILY, LS_RECENT, LS_HOT, LS_PLAYLISTS, lsFmt, lsIsUrl, lsCoverSize });
