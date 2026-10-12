import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ncm from 'NeteaseCloudMusicApi';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import dns from 'dns';
import net from 'net';
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DUETTO_DATA_DIR || path.join(process.env.LUMI_DATA_DIR || path.join(process.cwd(), 'data'), 'duetto');
const settingsFile = path.join(dataDir, 'settings.json');
const PORT = Number(process.env.DUETTO_INTERNAL_PORT || 0);
const DEFAULTS = { user_name:'You', ai_name:'DJ', room_name:'Our Room', room_sub:'', ai:{base_url:'',api_key:'',model:'',persona:''}, show_gallery:true, avatar_url:'', ai_avatar_url:'', background_url:'', theme:'' };
function getSettings(){ try{ const r=JSON.parse(fs.readFileSync(settingsFile,'utf8')); return {...DEFAULTS,...r,ai:{...DEFAULTS.ai,...(r.ai||{})}}; }catch(e){ return {...DEFAULTS}; } }
function redactSettings(s){ const out={...s,ai:{...(s&&s.ai||{})}}; if(out.ai.api_key){ out.ai.has_key=true; out.ai.key_hint='****'+String(out.ai.api_key).slice(-4); out.ai.api_key=''; } else { out.ai.has_key=false; out.ai.key_hint=''; } if(out.ai.a_key){ out.ai.has_a_key=true; out.ai.a_key_hint='****'+String(out.ai.a_key).slice(-4); out.ai.a_key=''; } else { out.ai.has_a_key=false; out.ai.a_key_hint=''; } return out; }
function writePrivate(file, text){ const tmp=file+'.tmp'; fs.writeFileSync(tmp, text, { mode: 0o600 }); try{ fs.chmodSync(tmp, 0o600); }catch(e){} fs.renameSync(tmp, file); try{ fs.chmodSync(file, 0o600); }catch(e){} }
// ═══ SQLite：长期档案（听歌流水/房间对话/歌曲分析/在场记录/印象）。JSON 只留瞬时状态（settings/cookie/封面缓存） ═══
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'listen.db');
const db = new DatabaseSync(dbFile);
try { fs.chmodSync(dbFile, 0o600); } catch(e) {}
db.exec(`
CREATE TABLE IF NOT EXISTS plays(id TEXT, title TEXT, artist TEXT, dur INTEGER DEFAULT 0, cover TEXT DEFAULT '', bucket TEXT DEFAULT '', ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_plays_id ON plays(id);
CREATE TABLE IF NOT EXISTS song_analysis(id TEXT PRIMARY KEY, title TEXT, artist TEXT, text TEXT, ts INTEGER, source TEXT NOT NULL DEFAULT 'unknown');
CREATE TABLE IF NOT EXISTS song_notes(song_id TEXT, title TEXT, artist TEXT, passage TEXT, thought TEXT, reply TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_notes_song ON song_notes(song_id, ts);
CREATE TABLE IF NOT EXISTS song_impressions(song_id TEXT, text TEXT, n INTEGER, ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_impr_song ON song_impressions(song_id, ts);
CREATE TABLE IF NOT EXISTS room_events(room TEXT, msg TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_events_room ON room_events(room, ts);
CREATE TABLE IF NOT EXISTS songs(id TEXT PRIMARY KEY, title TEXT, artist TEXT DEFAULT '', cover TEXT DEFAULT '', lyrics TEXT DEFAULT '', listen_count INTEGER DEFAULT 0, notes_count INTEGER DEFAULT 0, first_listened_at INTEGER DEFAULT 0, last_listened_at INTEGER DEFAULT 0, mem_summary TEXT DEFAULT '', mem_summary_n INTEGER DEFAULT 0, mem_summary_at INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
`);
try { if (!db.prepare('PRAGMA table_info(song_analysis)').all().some(column => column.name === 'source')) db.exec("ALTER TABLE song_analysis ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'"); } catch(e) { console.log('[song analysis migration]', e.message); }
// songs 回填：已有流水/印象长出主表行（幂等：只补不存在的）
try {
  db.exec("INSERT OR IGNORE INTO songs(id,title,artist,cover,listen_count,first_listened_at,last_listened_at,created_at,updated_at) SELECT id, MAX(title), MAX(artist), MAX(cover), COUNT(*), MIN(ts), MAX(ts), MIN(ts), MAX(ts) FROM plays WHERE id!='' GROUP BY id");
  db.exec("INSERT OR IGNORE INTO songs(id,title,artist,notes_count,created_at,updated_at) SELECT song_id, MAX(title), MAX(artist), COUNT(*), MIN(ts), MAX(ts) FROM song_notes WHERE song_id!='' GROUP BY song_id");
  db.exec("UPDATE songs SET notes_count=(SELECT COUNT(*) FROM song_notes WHERE song_id=songs.id)");
  db.exec("UPDATE songs SET mem_summary=COALESCE((SELECT text FROM song_impressions WHERE song_id=songs.id ORDER BY ts DESC LIMIT 1),''), mem_summary_n=COALESCE((SELECT MAX(n) FROM song_impressions WHERE song_id=songs.id),0) WHERE mem_summary=''");
} catch(e){ console.log('[songs backfill]', e.message); }
const app=express();
app.use(express.json({limit:'2mb'}));
// ═══ 应用级门禁：首次打开设 PIN，之后所有 /api/* 与 /ws 需要 token（网易云登录只是登网易账号，这道门才是应用自己的锁） ═══
const authFile = path.join(dataDir, 'auth.json');
function readAuth(){ try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch(e){ return null; } }
function writeAuth(a){ fs.mkdirSync(dataDir, { recursive: true }); writePrivate(authFile, JSON.stringify(a)); }
function hashPin(pin, salt){ return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function makeToken(secret){ return crypto.createHmac('sha256', String(secret)).update('duetto-access').digest('hex'); }
function reqToken(req){ const h = String(req.headers['authorization'] || ''); if (h.startsWith('Bearer ')) return h.slice(7); try { return String((req.query && req.query.token) || ''); } catch(e){ return ''; } }
function tokenOk(t, secret){ try { const a=Buffer.from(String(t)); const b=Buffer.from(makeToken(secret)); return a.length===b.length && crypto.timingSafeEqual(a,b); } catch(e){ return false; } }
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/status' || req.path === '/auth/setup' || req.path === '/auth/login' || req.path === '/auth/session' || req.path === '/health') return next();
  const a = readAuth();
  if (!a) return res.status(401).json({ ok: false, error: 'not configured — set a PIN first' }); // 未配置：关门，只放行 auth 端点
  if (tokenOk(reqToken(req), a.secret)) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
});
const _loginHits = {};
app.get('/api/auth/status', (_q, r) => { const a = readAuth(); r.json({ ok: true, configured: !!a && a.pinConfigured !== false }); });
app.post('/api/auth/session', (q, r) => {
  if (q.get('x-lumi-native-auth') !== '1') return r.status(401).json({ ok: false, error: 'unauthorized' });
  let a = readAuth();
  if (!a) {
    const salt = crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    a = { salt, hash: hashPin(crypto.randomBytes(32).toString('hex'), salt), secret, created: Date.now(), pinConfigured: false };
    writeAuth(a);
  }
  r.json({ ok: true, token: makeToken(a.secret) });
});
app.post('/api/auth/setup', (q, r) => { const existing = readAuth(); if (existing && existing.pinConfigured !== false) return r.status(409).json({ ok: false, error: 'already configured' }); const pin = String((q.body || {}).pin || ''); if (pin.length < 4) return r.status(400).json({ ok: false, error: 'PIN 至少 4 位' }); const salt = crypto.randomBytes(16).toString('hex'); const secret = existing?.secret || crypto.randomBytes(32).toString('hex'); writeAuth({ ...(existing || {}), salt, hash: hashPin(pin, salt), secret, created: existing?.created || Date.now(), pinConfigured: true }); r.json({ ok: true, token: makeToken(secret) }); });
app.post('/api/auth/login', async (q, r) => { const a = readAuth(); if (!a) return r.status(400).json({ ok: false, error: 'not configured' }); const ip = String(req_ip(q)); const now = Date.now(); const rec = _loginHits[ip] || { n: 0, until: 0 }; if (rec.until > now) return r.status(429).json({ ok: false, error: '尝试太频繁，稍后再试' }); const pin = String((q.body || {}).pin || ''); let h; try { h = await new Promise((res, rej) => crypto.scrypt(String(pin), a.salt, 32, (e, k) => e ? rej(e) : res(k.toString('hex')))); } catch(e){ return r.status(500).json({ ok:false }); } const ok = h.length === a.hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(a.hash)); if (!ok) { rec.n++; if (rec.n >= 5) { rec.until = now + Math.min(15*60000, 1000 * Math.pow(2, rec.n - 5)); } _loginHits[ip] = rec; return r.status(401).json({ ok: false, error: 'PIN 不对' }); } delete _loginHits[ip]; r.json({ ok: true, token: makeToken(a.secret) }); });
function req_ip(q){ try { return (String(q.headers['x-forwarded-for']||'').split(',')[0].trim()) || (q.socket && q.socket.remoteAddress) || 'ip'; } catch(e){ return 'ip'; } }
app.get('/api/health',(_q,r)=>r.json({ok:true,mode:'self-host',version:'1.0.0'}));
app.get('/api/config',(_q,r)=>{ const s=getSettings(); r.json({ok:true,config:{companion:{name:s.ai_name,has_key:Boolean(s.ai.api_key),model:s.ai.model},user:{display_name:s.user_name},room:{title:s.room_name,subtitle:s.room_sub}}}); });
app.get('/api/settings',(_q,r)=>{ r.json({ok:true,settings:redactSettings(getSettings())}); });
app.post('/api/settings',(q,r)=>{ try{ const cur=getSettings(); const b=q.body||{}; const bai={...(b.ai||{})}; const hasOwn=(o,k)=>Object.prototype.hasOwnProperty.call(o,k); const apiKeyProvided=!!(bai.api_key&&!/^\*/.test(String(bai.api_key))); const aKeyProvided=!!(bai.a_key&&!/^\*/.test(String(bai.a_key))); const baseChanging=hasOwn(bai,'base_url')&&String(bai.base_url||'')!==String((cur.ai&&cur.ai.base_url)||''); const aBaseChanging=hasOwn(bai,'a_base')&&String(bai.a_base||'')!==String((cur.ai&&cur.ai.a_base)||''); if(!apiKeyProvided)delete bai.api_key; if(!aKeyProvided)delete bai.a_key; delete bai.has_key; delete bai.key_hint; delete bai.has_a_key; delete bai.a_key_hint; const next={...cur,...b,ai:{...cur.ai,...bai}}; if(baseChanging&&!apiKeyProvided)next.ai.api_key=''; if(aBaseChanging&&!aKeyProvided)next.ai.a_key=''; fs.mkdirSync(dataDir,{recursive:true}); writePrivate(settingsFile,JSON.stringify(next,null,2)); r.json({ok:true,settings:redactSettings(next)}); }catch(e){ r.status(500).json({ok:false,error:e.message}); } });
app.post('/api/models',async(q,r)=>{ try{ const {base_url,api_key}=q.body||{}; if(!base_url)return r.status(400).json({ok:false,error:'base_url required'}); const base=String(base_url).replace(/\/+$/,''); if(!/^https:\/\//.test(base)) return r.status(400).json({ok:false,error:'base_url must be https'}); try{ await assertPublicUrl(base); }catch(e){ return r.status(400).json({ok:false,error:'endpoint not allowed'}); } const rr=await fetchT(base+'/models',{headers:api_key?{Authorization:'Bearer '+api_key}:{},redirect:'error'},15000); if(!rr.ok){return r.status(502).json({ok:false,error:'models endpoint returned '+rr.status});} const d=await rr.json(); const arr=Array.isArray(d)?d:(d.data||d.models||[]); r.json({ok:true,models:arr.map(m=>typeof m==='string'?m:(m.id||m.name||m.model||'')).filter(Boolean).sort((a,b)=>a.localeCompare(b,'zh-Hans-CN'))}); }catch(e){ r.status(500).json({ok:false,error:e.message}); } });
app.post('/api/analysis-models',async(q,r)=>{ try{ const saved=getSettings().ai||{}, b=q.body||{}; const base=String(b.base_url||saved.a_base||saved.base_url||'').replace(/\/+$/,''); const key=String(b.api_key||saved.a_key||saved.api_key||''); if(!base)return r.status(400).json({ok:false,error:'请先填写听歌分析模型服务地址'}); if(!/^https:\/\//.test(base))return r.status(400).json({ok:false,error:'服务地址必须使用 HTTPS'}); try{ await assertPublicUrl(base); }catch(e){ return r.status(400).json({ok:false,error:'endpoint not allowed'}); } const rr=await fetchT(base+'/models',{headers:key?{Authorization:'Bearer '+key}:{},redirect:'error'},15000); if(!rr.ok)return r.status(502).json({ok:false,error:'models endpoint returned '+rr.status}); const d=await rr.json(); const arr=Array.isArray(d)?d:(d.data||d.models||[]); r.json({ok:true,models:arr.map(m=>typeof m==='string'?m:(m.id||m.name||m.model||'')).filter(Boolean).sort((a,b)=>a.localeCompare(b,'zh-Hans-CN'))}); }catch(e){ r.status(500).json({ok:false,error:e.message}); } });
function mergeAi(base,over){ const out={...base}; if(over&&typeof over==='object'){ for(const k of ['model','persona','style','ai_name','user_name','time_aware','reply_mode','a_model']){ const v=over[k]; if(v!==undefined&&v!==null&&v!=='')out[k]=v; } if(over.base_url&&over.api_key){ out.base_url=over.base_url; out.api_key=over.api_key; } if(over.a_base&&over.a_key){ out.a_base=over.a_base; out.a_key=over.a_key; } } return out; }
// ═══ SSRF 防线：解析主机名，若任一 IP 落在私网/环回/链路本地段则拒绝 ═══
function isPrivateIp(ip){
  if(!ip) return true;
  if(net.isIPv4(ip)){
    const p=ip.split('.').map(Number);
    if(p[0]===10||p[0]===127||p[0]===0) return true;
    if(p[0]===172&&p[1]>=16&&p[1]<=31) return true;
    if(p[0]===192&&p[1]===168) return true;
    if(p[0]===169&&p[1]===254) return true;               // link-local / cloud metadata
    if(p[0]===100&&p[1]>=64&&p[1]<=127) return true;      // CGNAT
    if(p[0]>=224) return true;                             // multicast/reserved
    return false;
  }
  const s=ip.toLowerCase();
  if(s==='::1'||s==='::'||s.startsWith('fe80')||s.startsWith('fc')||s.startsWith('fd')) return true;
  if(s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));  // IPv4-mapped
  return false;
}
async function assertPublicUrl(urlStr, { allowHttp=false } = {}){
  let u; try { u = new URL(String(urlStr)); } catch(e){ throw new Error('bad url'); }
  if(u.protocol!=='https:' && !(allowHttp && u.protocol==='http:')) throw new Error('scheme not allowed');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  if(net.isIP(host)){ if(isPrivateIp(host)) throw new Error('private address'); return; }
  const addrs=await dns.promises.lookup(host,{all:true});
  if(!addrs.length) throw new Error('unresolved');
  for(const a of addrs){ if(isPrivateIp(a.address)) throw new Error('resolves to private address'); }
}
// 有大小上限+超时的流式下载（防内存爆/慢速挂起）；redirect:'error' 防跨主机跳转绕过 SSRF 检查
async function fetchCapped(urlStr, { maxBytes=100*1024*1024, timeoutMs=90000, headers={} } = {}){
  const ac=new AbortController(); const t=setTimeout(()=>ac.abort(), timeoutMs);
  try {
    const rr=await fetch(urlStr,{ headers, redirect:'error', signal:ac.signal });
    const ct=String(rr.headers.get('content-type')||'').toLowerCase();
    const finalUrl=String(rr.url||'');
    const reader=rr.body && rr.body.getReader ? rr.body.getReader() : null;
    if(!reader){ const b=Buffer.from(await rr.arrayBuffer()); if(b.length>maxBytes) throw new Error('too large'); return { buf:b, ct, finalUrl }; }
    const chunks=[]; let total=0;
    for(;;){ const {done,value}=await reader.read(); if(done) break; total+=value.length; if(total>maxBytes){ try{ac.abort();}catch(e){} throw new Error('too large'); } chunks.push(Buffer.from(value)); }
    return { buf:Buffer.concat(chunks), ct, finalUrl };
  } finally { clearTimeout(t); }
}
function timeBucket(h){ if(h<5)return '深夜'; if(h<9)return '清晨'; if(h<12)return '上午'; if(h<14)return '午间'; if(h<18)return '下午'; if(h<23)return '晚上'; return '深夜'; }
// 外部记忆接口（可选）：settings.ai.context_url 指向部署者自己的记忆/召回服务，
// 每次对话 POST {message, song, user, ai}，把返回的 {context} 文本注入提示词——新用户接自己的记忆体系用
async function fetchContext(s, prompt, np){
  const u = s.ai && s.ai.context_url; if (!u || !/^https:/.test(String(u))) return '';
  try {
    await assertPublicUrl(String(u));
    const rr = await fetchT(String(u), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message:String(prompt||''), song: np?{id:np.id,title:np.title,artist:np.artist}:null, user:(s.ai.user_name||''), ai:(s.ai.ai_name||'') }) }, 4000);
    if (!rr.ok) return '';
    const d = await rr.json().catch(()=>null);
    return String((d && (d.context || d.text || d.memory)) || '').slice(0, 4000);
  } catch(e){ return ''; }
}
function sysPrompt(s,kind,np,ctx){ const who=s.ai.ai_name||s.ai_name||'DJ',partner=s.ai.user_name||s.user_name||'You'; const scene=kind==='book'?'一起读书':'一起听歌'; const stream=s.ai.reply_mode==='stream';
 // 稳定前缀在前（persona/身份/格式/DJ 指令），会变的时间与"正在播"放最后 —— 中转的前缀缓存才能命中
 const ident='你叫'+who+'，正在和'+partner+scene+'。'+(kind==='book'?'':'你们正窝在一起听歌。就像平时那样自然地陪伴和回应，别端着、别解释自己、别写系统说明。专注音乐、歌词、'+partner+'此刻的心情、你们一起听歌的记忆；别主动扯无关的日常。下面给你的正在播和记忆只当背景，别复述。');
 const fmt=(stream?'（回复格式，无论上面的对话历史长什么样，从这一条起严格按此执行）你的每条回复都必须以 <thinking> 开头：先在 <thinking>...</thinking> 里写下你此刻真实的内心活动（'+partner+'看得见），闭合标签后紧接着写正文——一条完整的回复，自然的对话节奏，可以包含动作、心理、对白，不需要微信式短消息拆段；不返回 JSON 数组、不返回 markdown 代码块，直接纯文本。':'用自然的口语回复；不要分点、不要标签、不要解释你的格式。不要用星号或任何 markdown 符号包裹文字。你的整个回复输出成一个 JSON 数组，每个元素是一条独立的聊天气泡，像在聊天软件里连着发消息那样：["第一条","第二条"]。通常 1-4 条，每条一两句话；只输出这个数组本身，别的什么都不要。')+'回复里永远用第一人称「我」指代自己、用第二人称「你」指代'+partner+'，不要用第三人称称呼对方。';
 const dj=stream?'你可以控制播放器。当你想放某首歌/切歌/暂停/继续时，在回复的最后单独一行输出：<<ACT>>{"type":"play","query":"歌名 歌手"}<<>>（play 需要 query；下一首用 type:"next"、上一首 "prev"、暂停 "pause"、继续 "resume"）。分享一首歌用 {"type":"share","query":"歌名 歌手"}，分享当前这首 {"type":"share"}；红心 {"type":"like"}；加队列 {"type":"queue","query":"歌名 歌手"}。正常聊天时不要输出 ACT，也不要解释这个格式。':'你可以控制播放器。当你想放某首歌/切歌/暂停/继续时，把这个指令作为数组的最后一个元素单独输出：<<ACT>>{"type":"play","query":"歌名 歌手"}<<>>（play 需要 query；下一首用 type:"next"、上一首 "prev"、暂停 "pause"、继续 "resume"，这些不需要 query）。想把一首歌推荐给对方但不打断当前播放时，同样作为数组最后一个元素输出：<<ACT>>{"type":"share","query":"歌名 歌手"}<<>>；分享当前正在放的这首用 {"type":"share"}（不带 query），会在房间里弹出分享卡片。给正在放的这首点红心用 {"type":"like"}；想把一首歌加进播放队列、不打断当前播放，用 {"type":"queue","query":"歌名 歌手"}。正常聊天时不要输出 ACT，也不要解释这个格式。';
 let timeLine='';
 if(s.ai.time_aware!==false&&String(s.ai.time_aware)!=='false'){ try{ const now=new Date(); const cn=now.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}); const h=Number(now.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,hour:'2-digit'})); timeLine='现在是'+cn+'（'+timeBucket(h)+'）。'; }catch(e){} }
 let nowLine='';
 if(np&&np.title){
   nowLine='现在正在一起听：《'+np.title+'》'+(np.artist?('—'+np.artist):'')
     +((np.pos!=null&&np.dur)?(' · 进度 '+fmtSec(np.pos)+'/'+fmtSec(np.dur)):'')
     +((np.plays>1)?(' · 你们一起听过 '+np.plays+' 次'):'')+'。自然地结合它来回应。';
   if(np.cur_lyric) nowLine+='\n当前唱到：'+String(np.cur_lyric).slice(0,60);
   if(np.analysis) nowLine+='\n[听感 · 你认真听过这首歌，当背景别复述]\n'+np.analysis;
   if(np.impression) nowLine+='\n[这首歌的回忆 · 你们一起听它的印象总结]\n'+np.impression;
   if(np.notes&&np.notes.length) nowLine+='\n[这首歌最近的在场记录]\n'+np.notes.map(n=>'- '+(n.passage?('歌词「'+n.passage+'」'):'')+(n.thought?(' '+partner+'说：'+n.thought):'')+(n.reply?(' 你回：'+String(n.reply).slice(0,80)):'')).join('\n');
 }
 const styleLine=s.ai.style?('对话风格（用户设定，按这个方式说话）：'+s.ai.style):''; const ctxLine=ctx?('[你们的记忆 · 外部记忆系统提供，只当背景别复述]\n'+ctx):''; return [s.ai.persona,styleLine,ident,fmt,dj,ctxLine,timeLine,nowLine].filter(Boolean).join('\n\n'); }
// —— 在场记录（问Ta 的问答挂歌落库）与"印象"（记录满 6 条滚动总结成回忆） ——
function readNotes(sid, limit){ try { const rows = db.prepare('SELECT song_id AS id,title,artist,passage,thought,reply,ts FROM song_notes WHERE song_id=? ORDER BY ts DESC, rowid DESC' + (limit ? ' LIMIT ' + Number(limit) : '')).all(String(sid)); return rows.reverse(); } catch(e){ return []; } }
function readImpression(sid){ try { const r = db.prepare("SELECT mem_summary AS text, mem_summary_n AS n, mem_summary_at AS ts FROM songs WHERE id=? AND mem_summary!=''").get(String(sid)); return r || null; } catch(e){ return null; } }
function tlabel(ts){ try { const d = new Date(ts); return (d.getMonth()+1) + '/' + d.getDate() + ' ' + (d.getHours()<10?'0':'') + d.getHours() + ':' + (d.getMinutes()<10?'0':'') + d.getMinutes(); } catch(e){ return ''; } }
function countPlays(sid){ try { const r = db.prepare('SELECT COUNT(*) AS c FROM plays WHERE id=?').get(String(sid)); return (r && r.c) || 0; } catch(e){ return 0; } }
const IMPRESSION_EVERY = 6; // 在场记录每满 6 条，滚动总结一次印象
const _imBusy = {};
const _imFail = {}; // sid -> ts：印象生成失败退避
function maybeImpress(s, sid, title, artist){
  try {
    if (!sid || _imBusy[sid]) return;
    if (_imFail[sid] && (Date.now() - _imFail[sid]) < 600000) return; // 近期失败过，退避 10 分钟
    const notes = readNotes(sid);
    const impr = readImpression(sid);
    const n0 = impr ? (impr.n || 0) : 0;
    if (notes.length - n0 < IMPRESSION_EVERY) return;
    _imBusy[sid] = 1;
    (async () => {
      try {
        const fresh = notes.slice(n0).slice(-30); // 上限 30 条，防提示词无限膨胀
        const who2 = (s.ai && s.ai.user_name) || 'TA';
        const lines = fresh.map(n => '[' + tlabel(n.ts) + '] ' + (n.passage ? ('歌词「' + n.passage + '」') : '') + (n.thought ? (' ' + who2 + '说：' + n.thought) : '') + (n.reply ? (' 我回：' + String(n.reply).slice(0, 200)) : '')).join('\n');
        let head = '把你和' + who2 + '一起听《' + (title || '') + '》' + (artist ? ('—' + artist) : '') + '的这些片段，揉成一段第一人称回忆总结。';
        if (impr && impr.text) head += '这是之前的总结，在它基础上自然续写别推翻：\n' + impr.text + '\n\n';
        head += '150字内，写你们和这首歌的故事与情绪流变，温柔具体，直接出正文，不要分点、不要标签。';
        const text = await callLLM(withAnalysisAi(s), [{ role: 'system', content: head }, { role: 'user', content: '新片段：\n' + lines }]);
        if (text) {
          const now2 = Date.now();
          db.prepare('INSERT INTO songs(id,title,artist,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(sid, title || '', artist || '', now2, now2);
          db.prepare('UPDATE songs SET mem_summary=?, mem_summary_n=?, mem_summary_at=? WHERE id=?').run(text, notes.length, now2, sid);
          db.prepare('INSERT INTO song_impressions(song_id,text,n,ts) VALUES(?,?,?,?)').run(sid, text, notes.length, now2);
        }
      } catch(e){ _imFail[sid] = Date.now(); } finally { delete _imBusy[sid]; }
    })();
  } catch(e){}
}
// 房间对话挂到正在放的歌上：进这首歌的在场记录并喂印象——对话就是档案
function logRoomNote(s, np, prompt, reply){
  try {
    if (!np || !np.id || !/^\d+$/.test(String(np.id))) return;
    const q2 = String(prompt||'').trim(), a2 = String(reply||'').trim();
    if (!q2 || !a2 || a2.startsWith('[AI ')) return;
    const sid = String(np.id), now = Date.now();
    let pass = String(np.quote || np.cur_lyric || '').slice(0, 120);
    let th2 = q2;
    if (np.quote) { const _ls = th2.split('\n'); if (_ls[0] && _ls[0].indexOf(np.quote) >= 0) th2 = _ls.slice(1).join('\n').trim() || th2; }
    if (!np.quote && /^[^:：]{1,8}\s*[:：]/.test(pass)) pass = '';
    db.prepare('INSERT INTO song_notes(song_id,title,artist,passage,thought,reply,ts) VALUES(?,?,?,?,?,?,?)').run(sid, np.title||'', np.artist||'', pass, th2.slice(0,500), a2.slice(0,1000), now);
    const cv=normCover(np.cover||'');
    db.prepare("INSERT INTO songs(id,title,artist,cover,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, cover=CASE WHEN excluded.cover!='' AND COALESCE(songs.cover,'')='' THEN excluded.cover ELSE songs.cover END, updated_at=excluded.updated_at").run(sid, np.title||'', np.artist||'', cv, now, now);
    db.prepare('UPDATE songs SET notes_count=notes_count+1 WHERE id=?').run(sid);
    if (s && withAnalysisAi(s).ai.api_key) maybeImpress(s, sid, np.title||'', np.artist||'');
  } catch(e){}
}
app.get('/api/prompt-preview',async(q,r)=>{ try{ const s0=getSettings(); const s={...s0, ai:{...s0.ai}}; if(String(q.query.mode||'')==='stream') s.ai.reply_mode='stream'; const np={ id:String(q.query.id||'25906124'), title:String(q.query.title||'晴天'), artist:String(q.query.artist||'周杰伦'), pos:100, dur:270, cur_lyric:String(q.query.lyric||'从前从前 有个人爱你很久') }; try { np.plays=countPlays(np.id); const a=readAnalysis(np.id); if(a)np.analysis=a.text; const im=readImpression(np.id); if(im)np.impression=im.text; const ns=readNotes(np.id, IMPRESSION_EVERY); if(ns.length)np.notes=ns; } catch(e){} r.type('text/plain').send(sysPrompt(s, 'music', np, q.query.ctx?String(q.query.ctx):'') + '\n\n────────\n（以上是 system 提示词。每次请求还会附带：房间最近 12 条对话，作为标准 user/assistant 消息历史跟在 system 之后——所以不显示在这里。）'); }catch(e){ r.status(500).json({ok:false,error:e.message}); } });
app.get('/api/song-analysis',(q,r)=>{ try{ const sid=String(q.query.id||''); const a=sid?readAnalysis(sid):null; const im=sid?readImpression(sid):null; r.json({ok:true, text:(a&&a.text)||'', source:(a&&a.source)||'', impression:(im&&im.text)||'', impression_n:(im&&im.n)||0, analyzed:!!a, analyzed_at:(a&&a.ts)||0}); }catch(e){ r.status(500).json({ok:false,error:e.message}); } });
app.get('/api/song-context',(q,r)=>{
  try{
    const sid=String(q.query.id||'');
    if(!sid) return r.status(400).json({ok:false,error:'id required'});
    const a=readAnalysis(sid), im=readImpression(sid);
    const pos=Math.max(0,Number(q.query.pos)||0);
    const row=db.prepare('SELECT lyrics FROM songs WHERE id=?').get(sid);
    const lyrics=String((row&&row.lyrics)||'');
    const timed=lyrics.split(/\r?\n/).flatMap(line=>{
      const re=/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]([^\[]*)/g;
      const out=[]; let m;
      while((m=re.exec(line))!==null){
        const t=Number(m[1])*60+Number(m[2])+Number('0.'+(m[3]||'0'));
        const text=String(m[4]||'').trim();
        if(text) out.push({t,text});
      }
      return out;
    }).sort((x,y)=>x.t-y.t);
    const lyric=timed.filter(x=>x.t<=pos).at(-1);
    const notes=db.prepare("SELECT song_id,title,artist,'' AS cover,passage,thought,reply,ts FROM song_notes WHERE song_id=? ORDER BY ts DESC,rowid DESC LIMIT 12").all(sid).reverse();
    r.json({ok:true,id:sid,plays:countPlays(sid),analysis:(a&&a.text)||'',analysis_source:(a&&a.source)||'',impression:(im&&im.text)||'',impression_n:(im&&im.n)||0,cur_lyric:lyric?lyric.text:'',notes});
  }catch(e){ r.status(500).json({ok:false,error:e.message}); }
});
app.get('/api/song-notes',async(q,r)=>{ try{ const sid=String(q.query.id||''); const limit=Math.min(200, Number(q.query.limit)||60); const sql=`SELECT n.song_id, COALESCE(NULLIF(n.title,''),s.title,'') AS title, COALESCE(NULLIF(n.artist,''),s.artist,'') AS artist, COALESCE(s.cover,'') AS cover, n.passage,n.thought,n.reply,n.ts FROM song_notes n LEFT JOIN songs s ON s.id=n.song_id`; const rows = sid ? db.prepare(sql+' WHERE n.song_id=? ORDER BY n.ts DESC, n.rowid DESC LIMIT ?').all(sid, limit) : db.prepare(sql+' ORDER BY n.ts DESC, n.rowid DESC LIMIT ?').all(limit); await fillCovers(rows.map(x=>({id:x.song_id, cover:x.cover}))); const cache=loadCoverCache(); for(const x of rows){ if(!x.cover && x.song_id && cache[x.song_id]) x.cover=cache[x.song_id]; } r.json({ok:true, notes:rows}); }catch(e){ r.status(500).json({ok:false,error:e.message}); } });
app.post('/api/song-note',(q,r)=>{ try{ const b=q.body||{}; const sid=String(b.id||''); if(!sid) return r.json({ok:false}); const s0=getSettings(); const s2={...s0, ai:mergeAi(s0.ai, b.ai)}; const now=Date.now(); db.prepare('INSERT INTO song_notes(song_id,title,artist,passage,thought,reply,ts) VALUES(?,?,?,?,?,?,?)').run(sid, String(b.title||''), String(b.artist||''), String(b.passage||''), String(b.thought||''), String(b.reply||''), now); try{ const cv=normCover(b.cover||''); db.prepare("INSERT INTO songs(id,title,artist,cover,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, cover=CASE WHEN excluded.cover!='' AND COALESCE(songs.cover,'')='' THEN excluded.cover ELSE songs.cover END, updated_at=excluded.updated_at").run(sid, String(b.title||''), String(b.artist||''), cv, now, now); db.prepare('UPDATE songs SET notes_count=notes_count+1 WHERE id=?').run(sid); }catch(e){} if(withAnalysisAi(s2).ai.api_key) maybeImpress(s2, sid, b.title, b.artist); r.json({ok:true}); }catch(e){ r.status(500).json({ok:false,error:e.message}); } });
function fmtSec(x){ x=Math.max(0,Math.floor(Number(x)||0)); return Math.floor(x/60)+':'+String(x%60).padStart(2,'0'); }
// 组装"正在播"的完整上下文：进度 / 播放次数 / 歌曲分析 / 印象（或在场记录）
async function enrichNp(s, np){
  if(!np || !np.id || !/^\d+$/.test(String(np.id))) return np;
  const sid = String(np.id);
  try { np.plays = countPlays(sid); } catch(e){}
  const a = readAnalysis(sid);
  if (a) np.analysis = a.text;
  else {
    const r = ensureAnalysis(s, np);
    const t = (r && typeof r.then === 'function') ? await Promise.race([r, new Promise(res => setTimeout(() => res(null), 110000))]) : r;
    if (t) np.analysis = t;
  }
  const im = readImpression(sid);
  if (im) np.impression = im.text;
  const ns = readNotes(sid, IMPRESSION_EVERY);
  if (ns.length) np.notes = ns;
  return np;
}
// —— 听后印象：对话时若正在放的歌还没有分析，就后台生成一份（服务端自己拉歌词）；
// 已有分析则注入对话上下文 —— 让 AI 是"真听过这首歌"的状态
const _anBusy = {};
const _anFail = {}; // sid -> ts：失败退避，1 小时内不重试
// Song downloads and audio-model calls each retain a full-track buffer. Run one
// analysis at a time so consecutive track changes cannot multiply memory use.
let _analysisTail = Promise.resolve();
function ensureAnalysis(s, np){
  try {
    if(!np || !np.id || !/^\d+$/.test(String(np.id))) return null;
    if(!withAnalysisAi(s).ai.api_key) return null;
    const sid = String(np.id);
    const hit = readAnalysis(sid);
    if (hit) return hit.text;
    if (_anBusy[sid]) return _anBusy[sid];
    if (_anFail[sid] && (Date.now() - _anFail[sid]) < 3600000) return null; // 近期失败过，先不重试
    const _pr = _analysisTail.then(async () => {
      try {
        let lrc = '';
        try { const sr = db.prepare('SELECT lyrics FROM songs WHERE id=?').get(sid); lrc = (sr && sr.lyrics) || ''; } catch(e){}
        if (!lrc) {
          try { const ly = await ncm.lyric({ id: sid, cookie: ncmCookie }); lrc = (ly.body && ly.body.lrc && ly.body.lrc.lyric) || ''; } catch(e){}
          if (lrc) { try { db.prepare('INSERT INTO songs(id,title,artist,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(sid, np.title||'', np.artist||'', Date.now(), Date.now()); db.prepare('UPDATE songs SET lyrics=? WHERE id=?').run(lrc, sid); } catch(e){} }
        }
        const s2 = withAnalysisAi(s);
        // 宫殿正统：下载整首音频让分析模型真的去听（input_audio 多模态）；拿不到音频或模型不支持时回落纯歌词
        let audioB64 = '';
        try {
          let aurl = (np.url && /^https?:/.test(String(np.url))) ? String(np.url) : '';
          if (!aurl) { try { const su = await ncm.song_url({ id: sid, cookie: ncmCookie }); aurl = (su.body && su.body.data && su.body.data[0] && su.body.data[0].url) || ''; } catch(e){} }
          if (!aurl && /^\d+$/.test(sid)) aurl = 'https://music.163.com/song/media/outer/url?id=' + sid + '.mp3';
          if (aurl) {
            await assertPublicUrl(aurl, { allowHttp: true }); // 拦内网地址：SSRF 防线
            const { buf, ct, finalUrl } = await fetchCapped(aurl, { maxBytes: 100*1024*1024, timeoutMs: 90000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' } });
            const isAudio = buf.length > 20000 && !String(finalUrl).includes('/404') && (ct.includes('audio') || ct.includes('mpeg') || ct.includes('octet-stream') || buf.slice(0, 3).toString() === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0));
            if (isAudio) audioB64 = buf.toString('base64');
          }
        } catch(e){ console.log('[analysis audio dl fail]', sid, e.message); }
        const head = (np.title || '这首歌') + (np.artist ? (' - ' + np.artist) : '');
        let text = ''; let usedAudio = false;
        if (audioB64) {
          const prompt = '你会收到一首歌的完整音频。请真的去听这首歌（不要凭歌名或常识编造），然后用中文做一份分时间段的赏析。开头第一行写「' + head + '」。\n按时间顺序自然分段，尽量带上大致时间点（如 0:00、0:45、1:30）：曲式结构（前奏/主歌/副歌/桥段/尾奏分别在哪个时间段）；情绪走向随时间如何起伏；人声状态（真假声切换、气声、爆发力等细节）；编曲变化（乐器层次、动态的增减）；最戳人的几句歌词。总字数控制在 450 字以内（这段会被注入对话上下文）。' + (lrc ? ('\n\n[完整歌词，行首[分:秒]是时间轴，引用歌词以这里为准]\n' + String(lrc).slice(0, 6000)) : '');
          try {
            text = await callLLM(s2, [{ role: 'user', content: [ { type: 'text', text: prompt }, { type: 'input_audio', input_audio: { data: audioB64, format: 'mp3' } } ] }], { timeout: 100000 });
Warning: truncated output (original token count: 4820)
Total output lines: 100

          } catch(e){ console.log('[analysis audio llm fail]', sid, e.message.slice(0, 200)); }
          if (text) usedAudio = true;
        }
        if (!text) {
          text = await callLLM(s2, [
            { role: 'system', content: '你在认真听一首歌。下面是它的完整歌词，行首[分:秒]是时间轴。用中文写一份随时间推进的听后赏析：曲式怎么铺开（主歌/副歌/桥段大致在哪一段）、情绪随时间怎么起伏、歌词里最戳你的两三句和为什么。第一人称，写给自己的备忘（之后会作为你聊天时的背景），450字以内，自然分段，不要罗列时间戳、不要标题、不要分点符号。' },
            { role: 'user', content: '歌：' + (np.title || '') + (np.artist ? (' — ' + np.artist) : '') + (lrc ? ('\n完整歌词：\n' + String(lrc).slice(0, 6000)) : '') }
          ]);
        }
        if (text) appendAnalysis({ id: sid, title: np.title || '', artist: np.artist || '', text, source: usedAudio ? 'audio' : 'lyrics', ts: Date.now() });
        console.log('[analysis]', sid, 'by', s2.ai.model, usedAudio ? '(audio)' : '(lyrics only)', text ? 'ok' : 'empty');
        if (!text) _anFail[sid] = Date.now();
        return text || null;
      } catch(e){ console.log('[analysis err]', sid, e.message); _anFail[sid] = Date.now(); return null; } finally { delete _anBusy[sid]; }
    });
    _analysisTail = _pr.then(() => undefined, () => undefined);
    _anBusy[sid] = _pr;
    return _pr;
  } catch(e) { return null; }
}
// 剥思考链（宫殿 parse_replies 的 Claude 模式）：闭合的 <thinking>...</thinking> 剥出来；未闭合容错——开标签之后的全当思考
function stripThinking(text){
  let t = String(text||'').trim(); let think = '';
  const m = t.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (m) { think = m[1].trim(); t = (t.slice(0, m.index) + t.slice(m.index + m[0].length)).trim(); }
  else { const m2 = t.match(/<thinking>/i); if (m2) { think = t.slice(m2.index + m2[0].length).trim(); t = t.slice(0, m2.index).trim(); if (!t) t = '（想得太长还没来得及开口……）'; } }
  if (t.startsWith('```')) t = t.split('\n').slice(1).join('\n');
  if (t.endsWith('```')) t = t.slice(0, t.lastIndexOf('```'));
  return { text: t.trim(), think };
}
// 宫殿 parse_replies 的 JS 版：模型按协议输出 JSON 数组 -> 拆成多条气泡；容错：数组前粘杂字就从第一个 [ 切进去；再不行按换行拆；最后整段一条
function parseReplies(text){
  let t=String(text||'').trim();
  if(t.startsWith('```')) t=t.split('\n').slice(1).join('\n');
  if(t.endsWith('```')) t=t.slice(0,t.lastIndexOf('```'));
  t=t.trim();
  const unwrap=r=>typeof r==='string'?r:(r&&typeof r==='object'?String(r.text||r.content||r.value||r.message||''):String(r==null?'':r));
  const fromArr=a=>{const o=a.map(unwrap).map(x=>String(x).trim()).filter(Boolean);return o.length?o:null;};
  try{ const pj=JSON.parse(t); if(Array.isArray(pj)){const o=fromArr(pj);if(o)return o;} else if(pj&&typeof pj==='object'){ for(const k of ['messages','replies','msgs','items','contents','reply']){ if(Array.isArray(pj[k])){const o=fromArr(pj[k]);if(o)return o;} } if(pj.text||pj.content){const o=fromArr([pj]);if(o)return o;} } }catch(e){}
  const bi=t.indexOf('['), bj=t.lastIndexOf(']');
  if(bi>=0&&bj>bi){ try{ const p2=JSON.parse(t.slice(bi,bj+1)); if(Array.isArray(p2)){const o=fromArr(p2);if(o)return o;} }catch(e){} }
  return t?t.split(/\n+/).map(x=>x.trim()).filter(Boolean):[];
}
function deStar(parts){ return parts.map(x=>String(x).replace(/^\*{1,2}([^*]+)\*{1,2}$/, '（$1）').replace(/\*{1,2}([^*\n]{1,60}?)\*{1,2}/g, '（$1）')); }
// 分析模型三件套：只填了模型名就回落聊天端点密钥
function withAnalysisAi(s){ const a=s.ai||{}; if(!(a.a_model||a.a_key||a.a_base)) return s; return { ...s, ai:{ ...a, base_url:a.a_base||a.base_url, api_key:a.a_key||a.api_key, model:a.a_model||a.model } }; }
async function fetchT(url,opts,ms){ const ac=new AbortController(); const t=setTimeout(function(){ ac.abort(); },ms||30000); try{ return await fetch(url,{...opts,signal:ac.signal}); } finally { clearTimeout(t); } }
async function callLLM(s,messages,over){ const base=String(s.ai.base_url||'').replace(/\/+$/,''); if(!s.ai.api_key)throw Object.assign(new Error('AI not configured'),{status:503}); const rr=await fetchT(base+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+s.ai.api_key},body:JSON.stringify({model:(over&&over.model)||s.ai.model,temperature:0.9,max_tokens:1024,messages})},(over&&over.timeout)||45000); if(!rr.ok){const t=await rr.text().catch(()=>'');throw Object.assign(new Error('LLM '+rr.status+': '+t.slice(0,200)),{status:502});} const d=await rr.json(); return (d.choices&&d.choices[0]&&d.choices[0].message&&d.choices[0].message.content||'').trim(); }
app.post('/api/chat',async(q,r)=>{ try{ const s0=getSettings(); const bb=q.body||{}; const s={...s0, ai:mergeAi(s0.ai,bb.ai)}; if(!s.ai.api_key)return r.status(503).json({ok:false,error:'AI not set up: open the Model tab and add your endpoint + key'}); const {kind='music',prompt='',history=[],nowPlaying=null}=q.body||{}; const np=nowPlaying||(bb.ai&&bb.ai.nowPlaying)||null; const past=Array.isArray(history)?history.slice(-12).filter(m=>m&&m.role&&typeof m.content==='string'):[]; if(np){ if(bb.ai&&bb.ai.quote) np.quote=String(bb.ai.quote).slice(0,120); await enrichNp(s,np); } const ctx=await fetchContext(s, prompt, np); const raw=await callLLM(s,[{role:'system',content:sysPrompt(s,kind,np,ctx)},...past,{role:'user',content:String(prompt)}]); let reply, think=''; if(s.ai.reply_mode==='stream'){ const st=stripThinking(raw); reply=st.text; think=st.think; } else { reply=deStar(parseReplies(raw)).join('\n'); } if(!(bb.ai&&bb.ai.no_note)) logRoomNote(s, np, prompt, reply); r.json({ok:true,reply,think}); }catch(e){ r.status(e.status||500).json({ok:false,error:e.message}); } });
// —— Song analysis: cached per song id so each song is analyzed once ——
function readAnalysis(sid){ try { return db.prepare("SELECT id,title,artist,text,ts,source FROM song_analysis WHERE id=? AND text!=''").get(String(sid)) || null; } catch(e){ return null; } }
function appendAnalysis(e){ try { db.prepare('INSERT OR REPLACE INTO song_analysis(id,title,artist,text,ts,source) VALUES(?,?,?,?,?,?)').run(String(e.id||''), e.title||'', e.artist||'', e.text||'', e.ts||Date.now(), e.source||'unknown'); } catch(err){} }
app.post('/api/song-analysis',async(q,r)=>{ try{ const b=q.body||{}; const sid=String(b.id||''); if(!sid||!/^[0-9]+$/.test(sid)) return r.status(400).json({ok:false,error:'valid song id required'}); const s0=getSettings(); const np={id:sid,title:String(b.title||''),artist:String(b.artist||''),url:String(b.audio_url||'')}; const text=await ensureAnalysis(s0,np); const hit=readAnalysis(sid); r.json({ok:true,text:text||'',source:(hit&&hit.source)||'',cached:!!hit,analyzed:!!hit}); }catch(e){ r.status(e.status||500).json({ok:false,error:e.message}); } });
// —— NetEase Cloud Music: real QR login ——
const ncmCookieFile = path.join(dataDir, 'ncm-cookie.txt');
let ncmCookie = '';
try { ncmCookie = fs.readFileSync(ncmCookieFile, 'utf8'); } catch (e) {}
function saveNcmCookie(v){ ncmCookie = v || ''; try { fs.mkdirSync(dataDir,{recursive:true}); writePrivate(ncmCookieFile, ncmCookie); } catch(e){} }
async function ncmProfile(){ if(!ncmCookie) return null; try{ const st=await ncm.login_status({ cookie: ncmCookie }); const p=st.body&&st.body.data&&st.body.data.profile; return p||null; }catch(e){ return null; } }
app.get('/api/ncm/qr', async (_q,r)=>{ try{ const k=await ncm.login_qr_key({}); const key=k.body.data.unikey; const c=await ncm.login_qr_create({ key, qrimg:true }); r.json({ ok:true, key, qrimg:c.body.data.qrimg }); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.get('/api/ncm/check', async (q,r)=>{ try{ const key=q.qu…820 tokens truncated…}catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.get('/api/ncm/search-artist', async (q,r)=>{ try{ const sr=await ncm.cloudsearch({ keywords:q.query.kw||'', type:100, limit:12, cookie:ncmCookie }); const artists=((sr.body&&sr.body.result&&sr.body.result.artists)||[]).map(a=>({ id:a.id, name:a.name, cover:(a.picUrl||a.img1v1Url||'').replace(/^http:/,'https:'), alias:(a.alias||a.alia||[]) })); r.json({ ok:true, artists }); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.get('/api/ncm/artist-songs', async (q,r)=>{ try{ const ts=await ncm.artist_top_song({ id:q.query.id, cookie:ncmCookie }); let arr=(ts.body&&ts.body.songs)||[]; if(!arr.length){ try{ const a=await ncm.artists({ id:q.query.id, cookie:ncmCookie }); arr=(a.body&&a.body.hotSongs)||[]; }catch(e){} } const songs=arr.map(ncmMapSong); r.json({ ok:true, songs }); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.get('/api/ncm/lyric', async (q,r)=>{ try{ const ly=await ncm.lyric({ id:q.query.id, cookie:ncmCookie }); r.json({ ok:true, lyric:(ly.body&&ly.body.lrc&&ly.body.lrc.lyric)||'', tlyric:(ly.body&&ly.body.tlyric&&ly.body.tlyric.lyric)||'' }); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.get('/api/ncm/comments', async (q,r)=>{ try{ const cm=await ncm.comment_music({ id:q.query.id, limit:20, offset:0, cookie:ncmCookie }); const b=cm.body||{}; const raw=(b.hotComments&&b.hotComments.length)?b.hotComments:(b.comments||[]); const comments=raw.map(c=>({ u:(c.user&&c.user.nickname)||'网易云用户', av:((c.user&&c.user.avatarUrl)||'').replace(/^http:/,'https:'), t:c.content||'', z:c.likedCount||0, time:c.timeStr||'' })); r.json({ok:true,comments,total:(b.total||0)}); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.get('/api/ncm/record', async (_q,r)=>{ try{ const p=await ncmProfile(); if(!p) return r.json({ok:true,logged:false,songs:[]}); let arr=[]; try{ const rc=await ncm.user_record({ uid:p.userId, type:1, cookie:ncmCookie }); arr=(rc.body&&(rc.body.weekData||rc.body.allData))||[]; }catch(e){} if(!arr.length){ try{ const r0=await ncm.user_record({ uid:p.userId, type:0, cookie:ncmCookie }); arr=(r0.body&&(r0.body.weekData||r0.body.allData))||[]; }catch(e){} } const songs=arr.map(x=>x&&x.song).filter(Boolean).map(ncmMapSong); r.json({ ok:true, logged:true, songs }); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.get('/api/ncm/toplist', async (q,r)=>{ try{ if(q.query.id){ const tr=await ncm.playlist_track_all({ id:q.query.id, limit:300, cookie:ncmCookie }); const songs=((tr.body&&tr.body.songs)||[]).map(ncmMapSong); return r.json({ ok:true, songs }); } const t=await ncm.toplist({ cookie:ncmCookie }); const lists=((t.body&&t.body.list)||[]).map(x=>({ id:x.id, name:x.name, cover:x.coverImgUrl||x.coverImageUrl||'', updateFrequency:x.updateFrequency||'' })); r.json({ ok:true, lists }); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.post('/api/ncm/playlist-add', async (q,r)=>{ try{ const pid=String(q.query.pid||''), id=String(q.query.id||''); if(!/^\d+$/.test(pid)||!/^\d+$/.test(id)) return r.status(400).json({ok:false,error:'one playlist id and one song id are required'}); await ncm.playlist_tracks({ op:'add', pid, tracks:id, cookie:ncmCookie }); r.json({ ok:true, added:id }); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.post('/api/ncm/playlist-del', async (q,r)=>{ try{ const pid=String(q.query.pid||''), id=String(q.query.id||''); if(!/^\d+$/.test(pid)||!/^\d+$/.test(id)) return r.status(400).json({ok:false,error:'one playlist id and one song id are required'}); await ncm.playlist_tracks({ op:'del', pid, tracks:id, cookie:ncmCookie }); r.json({ ok:true, removed:id }); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.post('/api/ncm/like', async (q,r)=>{ try{ await ncm.like({ id:q.query.id, like:(q.query.like==='1'||q.query.like==='true'), cookie:ncmCookie }); r.json({ ok:true }); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
app.get('/api/ncm/likelist', async (_q,r)=>{ try{ const p=await ncmProfile(); if(!p) return r.json({ok:true,logged:false,ids:[]}); const ll=await ncm.likelist({ uid:p.userId, cookie:ncmCookie }); r.json({ ok:true, ids:(ll.body&&ll.body.ids)||[] }); }catch(e){ r.status(500).json({ok:false,error:String(e.message||e)}); } });
// —— Room timeline persistence: append-only JSONL, zero deps ——
function appendEvent(ev){ try { db.prepare('INSERT INTO room_events(room,msg,ts) VALUES(?,?,?)').run(String(ev.room||'main'), JSON.stringify(ev.msg||{}), ev.ts||Date.now()); } catch(e){} }
function readEvents(room, limit){ try { const rows = db.prepare('SELECT msg, ts FROM room_events WHERE room=? ORDER BY ts DESC, rowid DESC LIMIT ?').all(String(room), Number(limit)||120); return rows.map(r=>{ try{ const o=JSON.parse(r.msg); if(o && o.ts==null) o.ts=r.ts; return o; }catch(e){ return null; } }).filter(Boolean).reverse(); } catch(e) { return []; } }
app.get('/api/room/events', (q,r)=>{ const room=String(q.query.room||'main'); const limit=Math.min(300, Number(q.query.limit)||120); r.json({ ok:true, events: readEvents(room, limit) }); });
function normCover(u){ return String(u||'').replace(/^http:/,'https:'); }

// —— Listening log: structured play history with time-of-day buckets ——
app.post('/api/listen-log',(q,r)=>{ try{ const b=q.body||{}; if(!b.title&&!b.id) return r.json({ok:false}); const now=Date.now(); const cv=normCover(b.cover||''); let h=12; try{ h=Number(new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,hour:'2-digit'})); }catch(e){} db.prepare('INSERT INTO plays(id,title,artist,dur,cover,bucket,ts) VALUES(?,?,?,?,?,?,?)').run(String(b.id||''), String(b.title||''), String(b.artist||''), Number(b.dur)||0, cv, timeBucket(h), now);
  if (b.id) { db.prepare("INSERT INTO songs(id,title,artist,cover,listen_count,first_listened_at,last_listened_at,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET listen_count=listen_count+1, last_listened_at=excluded.last_listened_at, updated_at=excluded.updated_at, title=excluded.title, artist=excluded.artist, cover=CASE WHEN excluded.cover!='' THEN excluded.cover ELSE cover END").run(String(b.id), String(b.title||''), String(b.artist||''), cv, now, now, now, now); const np={id:String(b.id),title:String(b.title||''),artist:String(b.artist||''),cover:cv,dur:Number(b.dur)||0,url:String(b.url||'')}; void ensureAnalysis(getSettings(),np); } r.json({ok:true}); }catch(e){ r.status(500).json({ok:false,error:e.message}); } });
app.get('/api/listen-log',(q,r)=>{ try{ const limit=Math.min(500, Number(q.query.limit)||100); const out=db.prepare('SELECT id,title,artist,dur,cover,bucket,ts FROM plays ORDER BY ts DESC, rowid DESC LIMIT ?').all(limit); r.json({ok:true,plays:out}); }catch(e){ r.status(500).json({ok:false,error:e.message}); } });

// —— 听歌档案：每首歌的聚合（次数/首末时间/听后印象）+ 总览（总量/时段分布/常听排行） ——
const coverCacheFile = path.join(dataDir, 'cover-cache.json');
let _coverCache = null;
function loadCoverCache(){ if(_coverCache) return _coverCache; try{ _coverCache = JSON.parse(fs.readFileSync(coverCacheFile,'utf8')); }catch(e){ _coverCache = {}; } return _coverCache; }
function saveCoverCache(cache){ try{ fs.mkdirSync(dataDir,{recursive:true}); writePrivate(coverCacheFile, JSON.stringify(cache)); }catch(e){} }
function backfillCover(id, cover){ try{ if(!id||!cover) return; const now=Date.now(); db.prepare("UPDATE songs SET cover=?, updated_at=CASE WHEN COALESCE(updated_at,0)=0 THEN ? ELSE updated_at END WHERE id=? AND COALESCE(cover,'')=''").run(cover, now, String(id)); db.prepare("UPDATE plays SET cover=? WHERE id=? AND COALESCE(cover,'')=''").run(cover, String(id)); }catch(e){} }
async function fillCovers(items){
  items = Array.isArray(items) ? items : [];
  const cache = loadCoverCache();
  const touched = [];
  for (const t of items) { if (!t.cover && t.id && cache[t.id]) { t.cover = cache[t.id]; touched.push([String(t.id), t.cover]); } }
  const need = [...new Set(items.filter(t => !t.cover && t.id && /^\d+$/.test(String(t.id))).map(t => String(t.id)))].slice(0, 60);
  if (need.length) {
    try {
      const d = await ncm.song_detail({ ids: need.join(','), cookie: ncmCookie });
      for (const s of ((d.body && d.body.songs) || [])) { const u = normCover(s.al && s.al.picUrl); if (u) { cache[String(s.id)] = u; touched.push([String(s.id), u]); } }
      saveCoverCache(cache);
      for (const t of items) { if (!t.cover && cache[t.id]) t.cover = cache[t.id]; }
    } catch(e) { console.log('[covers err]', e.message); }
  }
  const seen = new Set();
  for (const pair of touched) { const k = pair[0]; if (seen.has(k)) continue; seen.add(k); backfillCover(k, pair[1]); }
}
app.get('/api/listen-stats',async(q,r)=>{
  try {
    const arr = db.prepare("SELECT COALESCE(NULLIF(p.id,''),p.title) AS gk, MAX(p.id) AS id, p.title, MAX(p.artist) AS artist, MAX(COALESCE(NULLIF(p.cover,''),s.cover,'')) AS cover, COUNT(*) AS plays, MIN(p.ts) AS first, MAX(p.ts) AS last FROM plays p LEFT JOIN songs s ON s.id=p.id WHERE p.title!='' GROUP BY gk").all();
    const buckets = {}; for (const b of db.prepare("SELECT bucket, COUNT(*) AS c FROM plays WHERE bucket!='' GROUP BY bucket").all()) buckets[b.bucket] = b.c;
    const total = (db.prepare("SELECT COUNT(*) AS c FROM plays WHERE title!=''").get() || {}).c || 0;
    const top = arr.slice().sort((a,b)=>b.plays-a.plays).slice(0, 30);
    for (const t of top) { if (t.id) { const a = readAnalysis(t.id); if (a) t.vibe = a.text; } }
    const recent = arr.slice().sort((a,b)=>b.last-a.last).slice(0, 30);
    await fillCovers(top.concat(recent));
    r.json({ ok: true, total, distinct: arr.length, buckets, top, recent });
  } catch(e) { r.status(500).json({ ok: false, error: e.message }); }
});

app.use(express.static(path.join(rootDir,'frontend'), { setHeaders: (res, fp) => { if (/\.(html|webmanifest)$/.test(fp)) res.setHeader('Cache-Control', 'no-cache, must-revalidate'); } }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });
const rooms = new Map();
wss.on('connection', (sock, req) => {
  { let ok = false; try { const a = readAuth(); if (a) { const t = new URL(req.url, 'http://x').searchParams.get('token') || ''; ok = tokenOk(t, a.secret); } } catch(e){ ok = false; } if (!ok) { try { sock.close(4401, 'unauthorized'); } catch(e){} return; } }
  let room = 'main';
  try { room = new URL(req.url, 'http://x').searchParams.get('room') || 'main'; } catch (e) {}
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(sock);
  sock.on('message', async d => {
    let m; try { m = JSON.parse(d.toString()); } catch(e) { m = null; }
    if (m && m.t === 'ai') {
      try {
        const s0 = getSettings();
        const ai = m.ai ? mergeAi(s0.ai, m.ai) : s0.ai;
        if (!ai.api_key) { sock.send(JSON.stringify({ t:'ai', id:m.id, reply:'[AI not set up: add your endpoint + key in Settings or the Model tab]' })); return; }
        const eff = { ...s0, ai };
        const np = m.nowPlaying || (m.ai && m.ai.nowPlaying) || null;
        const hist = m.history || (m.ai && m.ai.history) || [];
        const past = Array.isArray(hist) ? hist.slice(-12).filter(x=>x&&x.role&&typeof x.content==='string') : [];
        if (np) { if (m.ai && m.ai.quote) np.quote = String(m.ai.quote).slice(0,120); await enrichNp(eff, np); }
        const ctx2 = await fetchContext(eff, m.prompt, np);
        const raw2 = await callLLM(eff, [{ role:'system', content: sysPrompt(eff, 'music', np, ctx2) }, ...past, { role:'user', content: String(m.prompt||'') }]);
        let reply, think2=''; if (eff.ai.reply_mode==='stream') { const st=stripThinking(raw2); reply=st.text; think2=st.think; } else { reply=deStar(parseReplies(raw2)).join('\n'); }
        if (!(m.ai && m.ai.no_note)) logRoomNote(eff, np, m.prompt, reply);
        sock.send(JSON.stringify({ t:'ai', id:m.id, reply, think: think2 }));
      } catch(e) { sock.send(JSON.stringify({ t:'ai', id:m.id, reply:'[AI error: '+e.message+']' })); }
      return;
    }
    // chat/share/system messages: persist to the room timeline, then relay
    if (m && m.t === 'chat' && m.msg) appendEvent({ room, msg: m.msg, ts: Date.now() });
    const set = rooms.get(room); if (set) for (const c of set) if (c !== sock && c.readyState === 1) c.send(d.toString());
  });
  sock.on('close', () => { const set = rooms.get(room); if (set) { set.delete(sock); if (!set.size) rooms.delete(room); } });
});
const ready = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
});
export { app as duettoApp, server as duettoServer, ready as duettoReady };
