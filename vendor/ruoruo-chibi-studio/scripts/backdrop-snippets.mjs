// 傻瓜背景的 B 路线版：把 backdrop.mjs 的三种套路预先渲染成可以整段复制的 SVG（snippets/衬底/），
// 颜色抽成 <style> 里的一小段，换色卡只换这一段（色号表在 snippets/衬底/色卡.md）。
//   node scripts/backdrop-snippets.mjs
// backdrop.mjs、render.mjs 或 palettes.json 改了就重跑，check.mjs 会比对。
// 底稿固定用小熊（头宽 100、头顶 y≈0、脚底 y≈101），大多数模板放进去刚好；特别宽或特别高的模板会压到一点，若若说没关系。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backdrop, PALETTES } from './backdrop.mjs';
import { renderChibi } from './render.mjs';
const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const BASE = '小熊', DEFAULT = '马卡龙7奶油薄荷';
export const STYLES = ['色块', '星星', '撒花'];
const HEX = /(fill|stroke|stop-color|flood-color)="(#[0-9a-f]{6})"/gi;

// 只渲染衬底（角色部件 hidden，形状还在，给 scatter 绕轮廓用）
function renderBack(style, pal) {
  const doc = JSON.parse(fs.readFileSync(R + `templates/${BASE}.chibi.json`, 'utf8'));
  const d = backdrop(doc, style, pal);
  const n = d.parts.length - doc.parts.length;
  const sticker = d.sticker;
  d.parts = d.parts.map((p, i) => (i < n ? p : { ...p, hidden: true }));
  delete d.sticker;
  return { svg: renderChibi({ ...d, pastel: true }), viewBox: d.viewBox, sticker };
}
const colorsOf = svg => [...svg.matchAll(HEX)].map(m => [m[1], m[2].toLowerCase()]);

export function build() {
  const files = {}, table = {};
  const names = Object.keys(PALETTES);
  for (const style of STYLES) {
    const runs = Object.fromEntries(names.map(k => [k, renderBack(style, k)]));
    const seqs = Object.fromEntries(names.map(k => [k, colorsOf(runs[k].svg)]));
    const N = seqs[DEFAULT].length;
    for (const k of names) if (seqs[k].length !== N) throw new Error(`${style}·${k} 的颜色数和默认色卡不一样，没法抽成色号表`);
    // 同一位置在 19 张色卡里的颜色串一样 → 同一个色号；所有色卡都一样的（比如白网点）不抽
    const slotOf = new Map(), slots = [];
    const at = Array.from({ length: N }, (_, i) => {
      const key = names.map(k => seqs[k][i][1]).join();
      if (new Set(key.split(',')).size === 1) return null;
      if (!slotOf.has(key)) { slotOf.set(key, slots.length + 1); slots.push(Object.fromEntries(names.map(k => [k, seqs[k][i][1]]))); }
      return slotOf.get(key);
    });
    const props = Array.from({ length: slots.length + 1 }, () => new Set());
    // 角色贴纸白边（撒花）：外圈颜色跟色卡走，也放进色号
    const { svg, viewBox, sticker } = runs[DEFAULT];
    let i = 0;
    let out = svg.replace(HEX, (m, prop, hex) => {
      const s = at[i++];
      if (!s) return m;
      props[s].add(prop);
      return `${m} class="bd-c${s}"`;
    });
    // 同一元素上可能有两个 class（fill + stroke 都抽了）：合成一个
    out = out.replace(/<[^>]+>/g, tag => {
      const cls = [...tag.matchAll(/ class="([^"]+)"/g)].map(m => m[1]);
      return cls.length > 1 ? tag.replace(/ class="[^"]+"/g, '').replace(/(\/?>)$/, ` class="${cls.join(' ')}"$1`) : tag;
    });
    // id 加前缀，免得和角色自己的 clip/filter 撞
    const ids = [...out.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    for (const id of ids) out = out.split(`id="${id}"`).join(`id="bd-${id}"`).split(`url(#${id})`).join(`url(#bd-${id})`);
    const body = out.split('</defs>\n')[1].replace(/\n<\/svg>\n$/, '');
    // 角色藏起来以后，它的头遮罩之类还留在 defs 里：衬底用不到的整段去掉
    const used = new Set([...body.matchAll(/url\(#([^)]+)\)/g)].map(m => m[1]));
    let defs = out.match(/<defs>\n([\s\S]*?)\n<\/defs>/)[1].split('\n').filter(l => { const id = l.match(/^<\w+ id="([^"]+)"/)?.[1]; return !id || used.has(id); });
    for (let again = true; again;) { again = false; for (const l of defs) for (const m of l.matchAll(/url\(#([^)]+)\)/g)) if (!used.has(m[1])) { used.add(m[1]); again = true; } }
    defs = out.match(/<defs>\n([\s\S]*?)\n<\/defs>/)[1].split('\n').filter(l => { const id = l.match(/^<\w+ id="([^"]+)"/)?.[1]; return !id || used.has(id); }).join('\n');
    const rule = (s, pal) => `.bd-c${s}{${[...props[s]].map(p => `${p}:${slots[s - 1][pal]}`).join(';')}}`;
    const styleFor = pal => `<style>${slots.map((_, j) => rule(j + 1, pal)).join('')}</style>`;
    table[style] = Object.fromEntries(names.map(k => [k, styleFor(k)]));
    let stickerNote = '', stickerDef = '';
    if (sticker) {
      // 角色整只的贴纸白边：外圈色跟色卡走
      const st = renderChibi({ viewBox, sticker, parts: [{ name: '角色', pts: [[0, 0], [1, 0], [1, 1]], fill: '#ccc' }] });
      const f = st.match(/<filter id="sticker-1"[^>]*>[\s\S]*?<\/filter>/)[0].replace('id="sticker-1"', 'id="bd-sticker-角色"');
      const edgeSlot = slots.findIndex(s => s[DEFAULT] === sticker.edge.toLowerCase()) + 1;
      stickerDef = '\n' + (edgeSlot ? f.replace(`flood-color="${sticker.edge}"`, `flood-color="${sticker.edge}" class="bd-c${edgeSlot}"`) : f);
      stickerNote = `\n- 撒花要给角色描一圈贴纸白边：把整只角色包进 <g filter="url(#bd-sticker-角色)">（滤镜已经在下面 <defs> 里）。`;
    }
    files[`${style}.svg`] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(' ')}" width="${viewBox[2] * 3}" height="${viewBox[3] * 3}" data-snippet="衬底-${style}">
<!--
傻瓜背景「${style}」（scripts/backdrop.mjs 同一套，底稿 ${BASE}，默认色卡 ${DEFAULT}；由 scripts/backdrop-snippets.mjs 生成）。
B 路线（不能跑 Node）这样用：
- 把你的 <svg> 的 viewBox 改成上面这个（角色坐标不动，头宽 100、头顶 y≈0 的模板都能直接放；特别宽高的模板压到一点没关系）。
- 把 <defs> 里的东西整段复制进你的 <defs>，把 <style> 也复制进去；把「衬底开始」到「衬底结束」整段贴在角色最前面（画在角色下面）。
- 原来模板的那块整张底色 <rect> 删掉，衬底自己带底色。
- 换色卡：只把 <style> 那一行换成 snippets/衬底/色卡.md 里对应色卡的那一行，别的一个字都不改。
- 不删、不简写、不凭记忆重写；滤镜 id 已经带 bd- 前缀，不会和角色撞。${stickerNote}
-->
<defs>
${styleFor(DEFAULT)}
${defs}${stickerDef}
</defs>
<!-- 衬底开始 -->
${body}
<!-- 衬底结束 -->
</svg>
`;
  }
  let md = `# 傻瓜背景的色卡色号（B 路线）

[snippets/衬底/](./) 里三个套路（[色块](色块.svg)、[星星](星星.svg)、[撒花](撒花.svg)）默认是「${DEFAULT}」。换色卡时，把文件 <defs> 里那一行 \`<style>…</style>\` 整行换成下面对应的那一行。色卡来自若若给的 19 张（[scripts/palettes.json](../../scripts/palettes.json)）。

能跑 Node 时别用这里，直接 \`node scripts/backdrop.mjs 角色.chibi.json 套路 色卡\`，它会按角色实际轮廓摆。

本文件由 \`node scripts/backdrop-snippets.mjs\` 生成，别手改。
`;
  for (const style of STYLES) {
    md += `\n## ${style}\n`;
    for (const k of names) md += `\n**${k}**（${PALETTES[k].join(' ')}）\n\n\`\`\`\n${table[style][k]}\n\`\`\`\n`;
  }
  files['色卡.md'] = md;
  return files;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  fs.mkdirSync(R + 'snippets/衬底', { recursive: true });
  for (const [name, text] of Object.entries(build())) { fs.writeFileSync(R + 'snippets/衬底/' + name, text); console.log('wrote snippets/衬底/' + name); }
}
