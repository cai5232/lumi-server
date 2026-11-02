const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const pageHosts = new Set(['xhslink.cn', 'xhslink.com', 'www.xiaohongshu.com', 'xiaohongshu.com']);
function approved(url, kind) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const ok = kind === 'page' ? pageHosts.has(host) : (host === 'ci.xiaohongshu.com' || host.endsWith('.xhscdn.com'));
  if (!ok || u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('不支持的链接地址');
  return u;
}
async function get(url, kind, limit) {
  let target = approved(url, kind);
  for (let i = 0; i < 5; i++) {
    const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { 'user-agent': UA, ...(kind === 'image' ? { referer: 'https://www.xiaohongshu.com/' } : {}) } });
    if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); if (!location) throw new Error('链接跳转失败'); target = approved(new URL(location, target), kind); continue; }
    if (!response.ok) throw new Error('小红书内容暂时无法访问');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('内容过大'); chunks.push(chunk); }
    return { bytes: Buffer.concat(chunks), type: response.headers.get('content-type') || '', url: target.href };
  }
  throw new Error('链接跳转次数过多');
}
function normalizeUndefined(value) {
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) { out += ch; if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') { quoted = true; out += ch; continue; }
    if (value.slice(i, i + 9) === 'undefined' && !/[\w$]/.test(value[i - 1] || '') && !/[\w$]/.test(value[i + 9] || '')) { out += 'null'; i += 8; continue; }
    out += ch;
  }
  return out;
}
export function parseNote(html, url) {
  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/);
  if (!match) throw new Error('未找到笔记内容');
  let state; try { state = JSON.parse(normalizeUndefined(match[1].trim())); } catch { throw new Error('笔记格式无法识别'); }
  const root = state.noteData || {};
  const note = root.data?.noteData || root.normalNotePreloadData?.noteData || root.normalNotePreloadData;
  if (!note?.title && !note?.desc) throw new Error('笔记内容不可用');
  const images = (note.imageList || []).map(x => x.url || x.infoList?.[0]?.url).map(s => {
    if (typeof s !== 'string' || !s) throw new Error('笔记图片地址缺失');
    const url = s.startsWith('//') ? 'https:' + s : s.replace(/^http:/, 'https:');
    approved(url, 'image');
    return url;
  });
  const comments = (root.data?.commentData?.comments || []).slice(0, 30).map(c => ({ user: c.user?.nickname || '', content: c.content || '' }));
  return { url, title: note.title || '', author: note.user?.nickName || '', desc: note.desc || '', images, comments, likedCount: String(note.interactInfo?.likedCount ?? ''), commentCount: String(note.interactInfo?.commentCount ?? ''), collectedCount: String(note.interactInfo?.collectedCount ?? '') };
}
export async function readNote(url) { const page = await get(url, 'page', 3_000_000); return parseNote(page.bytes.toString('utf8'), page.url); }
export async function readNoteImage(url) { const image = await get(url, 'image', 8_000_000); const mime = image.type.split(';')[0].toLowerCase(); if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) throw new Error('图片格式不支持'); return `data:${mime};base64,${image.bytes.toString('base64')}`; }
