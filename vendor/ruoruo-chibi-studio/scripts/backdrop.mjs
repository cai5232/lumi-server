// 傻瓜背景：给一只角色和一个套路，自动配好简单衬底（若若 11-24：「只做傻瓜」，场景背景交给小机自由发挥）。
//   node scripts/backdrop.mjs 角色.chibi.json 套路 [色卡名或编号] [输出.chibi.json]
//   套路：色块（笔刷色块 + 亮块 + 网点，裁进色块）/ 星星（浅色渐变底 + 十字星 + 网点）/ 撒花（贴纸白边 + 大心大星 + 绕一圈小涂鸦）
//   配色：从 palettes.json 里若若给的色卡取色（11-24「无脑组合」）。不写色卡就按角色主色自动挑一张：色卡里要有和角色主色拉得开的浅色。
//   色卡颜色按明度分工：有颜色的里面最浅、且和角色拉得开的做色块和大件，另一个做网点、星星和小涂鸦。
// 规则来自 references/finish.md「画面装饰与背景」：整体四边留一成白（pad 0.1）；装饰塞在头后上角、身体两侧，贴着角色轮廓，不撒到四角；
// 网点圆形、一小片、压在角色下面；星星腰 0.08–0.1；配色跟角色走。
import fs from 'node:fs';
import { expand } from './render.mjs';

// ---------- 颜色 ----------
const toHsl = c => {
  const v = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255), mx = Math.max(...v), mn = Math.min(...v), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === v[0] ? (v[1] - v[2]) / d + (v[1] < v[2] ? 6 : 0) : mx === v[1] ? (v[2] - v[0]) / d + 2 : (v[0] - v[1]) / d + 4;
  return [h * 60, s, l];
};
const hsl = (h, s, l) => {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const f = k => { const a = s * Math.min(l, 1 - l), t = (k + h / 30) % 12; return l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1)); };
  return '#' + [0, 8, 4].map(k => Math.round(f(k) * 255).toString(16).padStart(2, '0')).join('');
};

// ---------- 随机（同一个 seed 出同一张） ----------
const rng = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// ---------- 量角色 ----------
const numsOf = d => (d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
function boxOf(parts, re) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of parts) {
    if (p.hidden || (re && !re.test(p.name))) continue;
    if (p.pts) for (const q of p.pts) add(q[0], q[1]);
    else if (p.type === 'ellipse') { add(p.cx - p.rx, p.cy - p.ry); add(p.cx + p.rx, p.cy + p.ry); }
    else if (p.d) { const v = numsOf(p.d); for (let i = 0; i + 1 < v.length; i += 2) add(v[i], v[i + 1]); }
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
// 角色主色：头的颜色；灰色动物（饱和度很低）就借衣服或别的有颜色的大块，都没有就用暖奶油
function mainHue(parts) {
  const cand = parts.filter(p => typeof p.fill === 'string' && /^#[0-9a-f]{6}$/i.test(p.fill) && !p.clip && !p.hidden);
  const order = [/^头$/, /衣|裙|身体/, /./];
  for (const re of order) for (const p of cand) if (re.test(p.name)) { const [h, s] = toHsl(p.fill); if (s > 0.18) return { h, gray: false }; }
  return { h: 30, gray: true };
}

export const PALETTES = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(new URL('./palettes.json', import.meta.url), 'utf8'))).filter(([k]) => !k.startsWith('_')));
const mix = (c, w, t) => { const a = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)), b = [1, 3, 5].map(i => parseInt(w.slice(i, i + 2), 16));
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
// 自动挑色卡：和角色主色色相差得开的浅色越多越好；同分按 seed 轮
export function pickPalette(h0, gray, seed = 0) {
  const score = cols => cols.filter(c => { const [h, s, l] = toHsl(c); return l > 0.7 && s > 0.3 && (gray || hueGap(h, h0) > 35); }).length / cols.length;
  const ranked = Object.entries(PALETTES).map(([k, v], i) => [k, score(v) + ((i * 7 + seed * 13) % 10) / 100]).sort((a, b) => b[1] - a[1]);
  return ranked[(seed * 4) % ranked.length][0];   // 0/1/2 隔开取，免得三张都是同一系
}
export function clashes(cols, h0, gray) {
  if (gray) return false;
  return cols.filter(c => { const [h, s] = toHsl(c); return s > 0.3 && hueGap(h, h0) > 35; }).length < 2;
}
function roles(cols, h0, gray) {
  // 近白、近灰的颜色（饱和度很低）只能当画布底，不当色块：兑白以后就成了灰
  const byL = [...cols].sort((a, b) => toHsl(b)[2] - toHsl(a)[2]);
  const vivid = byL.filter(c => toHsl(c)[1] > 0.3);
  const far = c => gray || hueGap(toHsl(c)[0], h0) > 35;
  const pool = vivid.length ? vivid : byL;
  const light = pool.filter(far).concat(pool)[0];                    // 色块：有颜色的里面最浅、且和角色拉得开的
  const accent = pool.filter(c => c !== light && far(c) && hueGap(toHsl(c)[0], toHsl(light)[0]) > 25)[0] || pool.find(c => c !== light) || light;
  return { light, accent, all: cols, lightest: byL[0] };
}
export function backdrop(doc, style, palette, seed = 7) {
  const rnd = rng(seed * 97 + 1);
  const pick = (a, b) => a + (b - a) * rnd();
  const parts = expand(doc).filter(p => p.type !== 'line' && !(p.type === 'path' && !p.fill));
  const all = boxOf(parts), head = boxOf(parts, /^头$/);
  const bodyRe = /^(身体|衣服主体|衣身)$/;
  const body = parts.some(p => bodyRe.test(p.name)) ? boxOf(parts, bodyRe) : { ...all, y0: head.y1 - 9 };
  const { h: h0, gray } = mainHue(parts);
  if (palette === undefined || palette === '' || /^\d$/.test(String(palette))) palette = pickPalette(h0, gray, +(palette ?? 0));
  if (!PALETTES[palette] && !Array.isArray(palette)) throw new Error(`没有这张色卡：${palette}`);
  // 同色系色卡照用，不换（若若 11-24：「同色系不丑！好看！！申请保留」）。clashes() 只留着给自动挑色卡以外的人参考，这里不调。
  let swappedFrom;
  const cols = PALETTES[palette] || palette;
  const P = roles(cols, h0, gray);
  // 画框：角色包围盒外留一圈，再整体 pad 一成
  const side = Math.max(all.w, all.h) + 22, vb0 = [all.cx - side / 2, all.cy - side / 2 - 2, side, side];
  const pad = 0.1, k = 1 / (1 - 2 * pad), W = side * k;
  const viewBox = [vb0[0] - (W - side) / 2, vb0[1] - (W - side) / 2, W, W].map(v => +v.toFixed(2));
  const flip = rnd() < 0.5 ? 1 : -1;      // 大装饰放左边还是右边
  const L = flip > 0 ? all.x0 : all.x1, Rt = flip > 0 ? all.x1 : all.x0;   // L = 放大件的一侧
  const r1 = v => +v.toFixed(1);
  const around = [...new Set(parts.map(p => p.name).filter(nm => /^(头|身体|衣服主体|左耳|右耳|.*耳罩)$/.test(nm)))];
  const center = [r1(head.cx), r1((head.y0 + body.y1) / 2)];
  let background, back = [], sticker;

  if (style === '色块') {
    // 色块要淡但看得出颜色：HSL 饱和度高、明度很高（若若第一格 #ffe1e6 就是这样）；灰动物饱和度减半
    const blob = mix(P.light, '#ffffff', 0.35), lite = mix(P.light, '#ffffff', 0.7), dot = P.accent;
    background = mix(P.lightest, '#ffffff', 0.85);
    const rot = r1(pick(-14, -7) * flip);
    back = [
      { name: '涂鸦底', type: 'blob', cx: r1(head.cx), cy: r1(head.cy - 4), rx: r1(head.w * 0.78), ry: r1(head.h * 0.5), lobes: 9, wobble: 0.1, r: 40, seed: Math.floor(pick(1, 40)), fill: blob, brush: { scale: 13, freq: [0.035, 0.16] }, rot },
      { name: '手绘色块1', type: 'blob', cx: r1(body.cx), cy: r1(body.y1 - 6), rx: r1(all.w * 0.55), ry: r1(body.h * 0.55 + 6), lobes: 9, wobble: 0.1, r: 40, seed: Math.floor(pick(1, 40)), fill: blob, brush: { scale: 12.5, freq: [0.031, 0.124] }, rot },
      { name: '涂鸦底亮', type: 'blob', cx: r1(L - flip * 0), cy: r1(body.y1 - 4), rx: 24, ry: 9, lobes: 8, wobble: 0.14, r: 30, seed: 8, fill: lite, brush: 7, blur: 2, rot, clip: ['涂鸦底', '手绘色块1'] },
      { name: '涂鸦底网点', type: 'halftone', patch: [r1(Rt + flip * 9), r1(head.cy + 2), 16], edge: 0.6, gap: 3.4, size: 1.3, gamma: 1.2, fill: dot, clip: ['涂鸦底', '手绘色块1'] },
    ];
  } else if (style === '星星' || style === '浅星星') {
    // 星星只留浅色底（若若 11-24：「只保留浅色星星版本」）：
    // 色卡浅色兑白做渐变底，星星和线条小涂鸦用色卡里较深的颜色，网点白
    const g = (c, l, sMax = 0.6) => { const [h, s] = toHsl(c); return hsl(h, Math.min(s, sMax), l); };
    background = { linear: [[50, viewBox[1]], [50, viewBox[1] + W]], stops: [mix(P.light, '#ffffff', 0.45), mix(P.accent, '#ffffff', 0.75)] };
    const star = g(P.accent, 0.62, 0.7), dot = '#ffffff', line = g(P.light, 0.6, 0.7);
    back = [
      { name: '网点下', type: 'halftone', patch: [r1(Rt - flip * 18), r1(body.y1 - 4), 20.5], edge: 0.87, gap: 3.4, size: 1.45, gamma: 1.2, fill: dot },
      { name: '网点头后', type: 'halftone', patch: [r1(L + flip * 6), r1(head.y0 + 8), 26], edge: 0.65, gap: 3.4, size: 1.45, gamma: 1.85, fill: dot, angle: 40 },
      { name: '大星', type: 'sparkle', cx: r1(L - flip * 0), cy: r1(body.y1 - 7), size: 30, fill: star, waist: 0.1 },
      { name: '小星', type: 'sparkle', cx: r1(L - flip * 13), cy: r1(head.cy - 6), size: 13, fill: star, waist: 0.1 },
      { name: '远星', type: 'sparkle', cx: r1(Rt + flip * 6), cy: r1(head.y1 + 8), size: 14, fill: star, tipR: 0.014, waistR: 0.055, waist: 0.08 },
      { name: '远星小', type: 'sparkle', cx: r1(Rt - flip * 0), cy: r1(head.y1 + 18), size: 6.5, waist: 0.15, waistR: 0.075, tipR: 0, fill: star },
      { name: '圈圈', type: 'doodle', kind: 'spiral', cx: r1(Rt + flip * 10), cy: r1(head.y0 + 4), size: 10, stroke: line, sw: 1 },
      { name: '心', type: 'doodle', kind: 'heartLine', cx: r1(L + flip * 22), cy: r1(body.y1 + 4), size: 10, stroke: line, sw: 1, rot: -12 * flip },
    ];
  } else if (style === '撒花') {
    background = '#ffffff';
    // 小涂鸦直接用色卡原色（太浅的看不见，去掉明度 0.9 以上的）；大心大星用色卡色兑白
    const pal = P.all.filter(c => toHsl(c)[2] < 0.9); if (pal.length < 2) pal.push(...P.all);
    const soft1 = mix(P.light, '#ffffff', 0.4), soft2 = mix(P.accent, '#ffffff', 0.65);
    const edge = mix(P.lightest, '#ffffff', 0.3);
    back = [
      { name: '大心', type: 'doodle', kind: 'heart', cx: r1(Rt + flip * 3), cy: r1(body.cy - 2), size: 22, rot: 24 * flip, fill: soft1, sw: 0.4 },
      { name: '大星', type: 'sparkle', cx: r1(L + flip * 12), cy: r1(body.y1 - 7), size: 50, waist: 0.2, waistR: 0.09, fill: soft2, tipR: 0.076, rot: -29 * flip },
      { name: '大心网点', type: 'halftone', patch: [r1(Rt - flip * 15), r1(body.y1 + 4), 20], edge: 0.6, gap: 3.2, size: 1.2, gamma: 1.2, fill: mix(P.light, P.accent, 0.5) },
      { name: '大星网点', type: 'halftone', patch: [r1(L + flip * 2), r1(head.y0 + 14), 18], edge: 0.6, gap: 3.2, size: 1.2, gamma: 1.2, fill: P.accent },
      { name: '涂鸦', type: 'scatter', around, center, dist: 18.9, from: 29, to: 371, count: 11, jitter: [2, 8], size: [3, 10], sw: 1.5, seed: Math.floor(pick(1, 99)),
        sticker: { width: 1.3, edge, edgeWidth: 1 },
        kinds: ['heart', 'curl', 'confetti', 'note', 'starLine', 'star', 'plus', 'heartLine', 'sparkle', 'spiral', 'dot', 'cross', 'burst', 'ring', 'dash', 'tri', 'squiggle'], kindsInOrder: true,
        colors: Array.from({ length: 11 }, (_, i) => pal[i % pal.length]), colorsInOrder: true },
    ];
    sticker = { width: 2.5, color: '#ffffff', edge, edgeWidth: 1.7, edgeStyle: 'line' };
  } else throw new Error(`没有这个套路：${style}（色块 / 星星 / 撒花）`);

  const out = { ...doc, viewBox, background, backdrop: { style, palette: typeof palette === 'string' ? palette : '自定义', ...(swappedFrom ? { swappedFrom } : {}) }, parts: [...back, ...doc.parts] };
  if (sticker) out.sticker = sticker;
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [inp, style = '色块', palette, outp] = process.argv.slice(2);
  if (!inp) { console.error('用法：node scripts/backdrop.mjs 角色.chibi.json 色块|星星|撒花 [色卡名，或 0/1/2 自动挑的第几张] [输出.chibi.json]\n色卡：' + Object.keys(PALETTES).join('、')); process.exit(1); }
  const doc = backdrop(JSON.parse(fs.readFileSync(inp, 'utf8')), style, palette);
  const target = outp || inp.replace(/\.chibi\.json$/, '') + `·${style}·${doc.backdrop.palette}.chibi.json`;
  fs.writeFileSync(target, JSON.stringify(doc, null, 1) + '\n', 'utf8');
  if (doc.backdrop.swappedFrom) console.log(`色卡「${doc.backdrop.swappedFrom}」和角色撞色，换成了「${doc.backdrop.palette}」`);
  console.log('wrote', target);
}
