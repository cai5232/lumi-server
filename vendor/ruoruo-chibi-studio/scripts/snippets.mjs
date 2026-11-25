// 从 render.mjs 现在的输出里取出正式滤镜，写成 snippets/*.svg（B 路线整段复制用）。
// 滤镜区域改成相对自身外框的 -20%/140%，B 路线不用按画布改 x/y/width/height；滤镜里的每个 primitive 和渲染器逐字一致。
//   node scripts/snippets.mjs
// render.mjs 改了滤镜就重跑这个，check.mjs 会比对两边。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderChibi } from './render.mjs';
const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const svg = renderChibi({ viewBox: [0, 0, 100, 100], pastel: true, sticker: true,
  parts: [{ name: '色块', pts: [[10, 10], [90, 10], [90, 90], [10, 90]], r: 5, fill: '#ccc', brush: 8 }] });
const get = id => svg.match(new RegExp(`<filter id="${id}"[^>]*>(.*?)</filter>`))[1];
const REGION = 'x="-20%" y="-20%" width="140%" height="140%"';
const f = (id, extra = '') => `<filter id="${id}" ${REGION}${extra}>${get(id)}</filter>`;
const CI = ' color-interpolation-filters="sRGB"';
const DATE = '2026-11-24';

const files = {
  'pastel.svg': {
    note: `油画棒正式滤镜（render.mjs --pastel 同一套，${DATE}）。
B 路线交油画棒成品时：把下面 <defs> 里两个 <filter> 整段复制进你的 <defs>。
- 一个字都不改，不删、不简写、不凭记忆重写。少一个 primitive 文件照样合法，但 Safari 会把滤镜区域显示成灰色方块。
- 只允许给 id 加前缀（双角色：a-pastel、a-pastel-fine），引用的 url(#…) 跟着改。
- 角色按图层顺序切成连续几段：眼睛、虹膜、高光、睫毛、眉、鼻子、人中线、嘴线、嘴边弧线、胡须、舌，和所有没有填充的线条，包在 <g filter="url(#pastel-fine)">；其它部件包在 <g filter="url(#pastel)">。背景色块不包。`,
    defs: [f('pastel', CI), f('pastel-fine', CI)],
    demo: '<g filter="url(#pastel)"><rect x="20" y="20" width="60" height="60" rx="14" fill="#f2b98a"/></g><g filter="url(#pastel-fine)"><ellipse cx="40" cy="50" rx="3" ry="4" fill="#4a3b3b"/><ellipse cx="60" cy="50" rx="3" ry="4" fill="#4a3b3b"/></g>',
  },
  'sticker.svg': {
    note: `贴纸白边（render.mjs 顶层 sticker 默认值：白色、宽 2.4，${DATE}）。
整段复制进 <defs>，一个字都不改，只允许给 id 加前缀。把要描边的角色或装饰包在 <g filter="url(#sticker)">。
B 路线只用这一版；要换宽度、外圈色边（edge）时走 A 路线由 render.mjs 生成。`,
    defs: [f('sticker-1').replace('id="sticker-1"', 'id="sticker"')],
    demo: '<g filter="url(#sticker)"><circle cx="50" cy="50" r="28" fill="#f2b98a"/></g>',
  },
  'brush.svg': {
    note: `笔刷毛边（render.mjs 部件字段 brush: 8 的默认值，${DATE}），用在天空、草地、水面这类环境色块和涂鸦色块上。
整段复制进 <defs>，一个字都不改，只允许给 id 加前缀，把 filter="url(#brush)" 写在色块自己身上。
色块要当蒙版用时，把带 filter 的白色块放进 <mask>（不是 <clipPath>），毛边才会带进去。要别的毛边大小时走 A 路线。`,
    defs: [f('brush-1').replace('id="brush-1"', 'id="brush"')],
    demo: '<rect x="15" y="30" width="70" height="40" rx="10" fill="#cfe3b4" filter="url(#brush)"/>',
  },
};
fs.mkdirSync(R + 'snippets', { recursive: true });
for (const [name, { note, defs, demo }] of Object.entries(files)) {
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="300" height="300" data-snippet="${name.replace('.svg', '')}@${DATE}">\n<!--\n${note}\n-->\n<defs>\n${defs.join('\n')}\n</defs>\n${demo}\n</svg>\n`;
  fs.writeFileSync(R + 'snippets/' + name, out);
  console.log('wrote snippets/' + name);
}
