import { isIP } from 'node:net';

export const ENGAWA_PHOTO_TOOL = 'lumi_engawa_share_photo';
export const engawaPhotoTool = {
  name: ENGAWA_PHOTO_TOOL,
  description: '把本轮檐廊工具实际找到的一张图片带回聊天，生成可打开看大图的图片卡片。先用 apod 看天文照片，或 daily_art 按关键词找画作，再从返回结果中选择 image_url（APOD 使用 url）。可以写一句你想对言言说的话；不必每次都分享。不能编造图片地址，视频不能当作照片。',
  inputSchema: {
    type: 'object', properties: {
      image_url: { type: 'string', description: '本轮檐廊工具实际返回的图片地址，原样填写' },
      caption: { type: 'string', description: '想对言言说的话，或为什么想把这张图带给她' }
    }, required: ['image_url'], additionalProperties: false
  }
};

function publicImageURL(value) {
  if (typeof value !== 'string' || value.length > 4000) return '';
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || isIP(host) || host.includes(':') ||
        !host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) return '';
    return url.href;
  } catch { return ''; }
}

function toolData(result) {
  if (!result || result.isError) return null;
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (block.type !== 'text') continue;
    try { const data = JSON.parse(block.text); if (data && typeof data === 'object') return data; } catch {}
  }
  return result;
}

// Candidates are recorded by the server at execution time, never parsed from
// model-authored text. Keep only explicit image fields, not arbitrary page links.
export function engawaPhotoCandidates(result, toolName, args = {}) {
  const data = toolData(result);
  if (!data || data.ok === false || data.error) return [];
  const candidates = [];
  const add = (value, title = data.title, source = data.page_url || args.url, credit = data.artist || data.credit || '') => {
    const imageURL = publicImageURL(value);
    if (imageURL && !candidates.some(item => item.imageURL === imageURL)) candidates.push({
      imageURL, title: String(title || '檐廊带回的图片').slice(0, 200),
      sourceURL: publicImageURL(source), credit: String(credit).slice(0, 300)
    });
  };
  if (toolName === 'apod') {
    if (data.media_type !== 'image') return [];
    const source = /^\d{4}-\d{2}-\d{2}$/.test(data.date || '')
      ? `https://apod.nasa.gov/apod/ap${data.date.slice(2).replaceAll('-', '')}.html`
      : 'https://apod.nasa.gov/apod/astropix.html';
    add(data.url, data.title, source, 'NASA APOD');
    add(data.hdurl, data.title, source, 'NASA APOD');
  } else {
    add(data.image_url);
    for (const image of (Array.isArray(data.images) ? data.images : []).slice(0, 12)) {
      if (typeof image === 'string') add(image);
      else if (image && typeof image === 'object') add(image.url || image.image_url, image.title || image.alt || data.title, image.source_url || data.page_url || args.url, image.credit || data.artist || '');
    }
  }
  return candidates.slice(0, 12);
}

export function shareEngawaPhoto(toolTrace, args = {}) {
  const imageURL = publicImageURL(args.image_url);
  const photo = toolTrace.filter(call => call.succeeded === true)
    .flatMap(call => Array.isArray(call.engawaPhotos) ? call.engawaPhotos : [])
    .find(item => item.imageURL === imageURL);
  if (!imageURL || !photo) throw new Error('请先用檐廊工具取得真实图片，再原样选择返回的图片地址；本轮没有找到这张图片。');
  const shared = toolTrace.filter(call => call.name === ENGAWA_PHOTO_TOOL && call.succeeded).length;
  if (shared >= 4) throw new Error('这一轮最多带回四张图片。');
  return { ok: true, photo: { ...photo, caption: String(args.caption || '').slice(0, 1500) }, display: 'photo_card', note: '图片已加入本次回复的卡片，可以继续自然说话，不要另写 HTML 或 Markdown 图片。' };
}

const escapeHTML = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function engawaPhotoCard(toolTrace, reply = '') {
  const photos = [];
  for (const call of toolTrace) {
    if (call.name !== ENGAWA_PHOTO_TOOL || call.succeeded !== true) continue;
    let result;
    try { result = JSON.parse(call.result); } catch { continue; }
    const photo = result?.ok && result.photo;
    if (photo && publicImageURL(photo.imageURL) && !photos.some(item => item.imageURL === photo.imageURL)) photos.push(photo);
    if (photos.length === 4) break;
  }
  if (!photos.length) return null;
  const figures = photos.map(photo => `<figure><a href="${escapeHTML(photo.imageURL)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHTML(photo.imageURL)}" alt="${escapeHTML(photo.title)}" referrerpolicy="no-referrer"></a><figcaption><h2>${escapeHTML(photo.title)}</h2>${photo.caption ? `<p>${escapeHTML(photo.caption)}</p>` : ''}${photo.credit ? `<p class="credit">${escapeHTML(photo.credit)}</p>` : ''}<a href="${escapeHTML(photo.sourceURL || photo.imageURL)}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a></figcaption></figure>`).join('');
  return {
    htmlTitle: photos.length === 1 ? `叼给你看 · ${photos[0].title}` : `檐廊带回的 ${photos.length} 张图片`,
    htmlContent: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>檐廊带回的图片</title><style>body{margin:0;background:#faf7f1;color:#34312c;font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.65}main{max-width:760px;margin:auto;padding:24px 18px 40px}.intro,p{white-space:pre-wrap;overflow-wrap:anywhere}.eyebrow{color:#86725f;font-size:13px;letter-spacing:.15em}figure{margin:22px 0 0;background:#fff;border:1px solid #e9e1d6;border-radius:18px;overflow:hidden}img{display:block;width:100%;height:auto;min-height:100px;background:#eee9e0}figcaption{padding:16px 18px 20px}h2{font-size:18px;line-height:1.5;margin:0 0 10px}p{margin:10px 0}.credit{color:#82796e;font-size:12px}a{color:#765b43;text-underline-offset:4px}</style></head><body><main><div class="eyebrow">檐廊 · 叼给你看</div>${reply ? `<p class="intro">${escapeHTML(reply)}</p>` : ''}${figures}</main></body></html>`
  };
}
