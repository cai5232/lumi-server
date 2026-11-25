#!/usr/bin/env node
// 把若若在 Figma 导出的 compact.json（+ 同名 .smooth.svg 里的渐变）换算成 ruoruo-chibi@0.1，头宽 W = 100。
//   node scripts/convert.mjs 小猫1.compact.json 小猫1.chibi.json [标题]
// 规则：
//   - 以第一个不是遮罩的「头」为基准：原点挪到头的左上角，整体乘 100 / 头宽；圆角 < 100 的跟着缩放，大数（尽量圆）原样保留。
//   - 镜像过的形状（变换矩阵行列式 < 0）反转点的顺序。
//   - Figma 的 Mask group：遮罩形状变成一个 hidden 部件，同组里排在它后面的部件都写 clip 指向它。
//   - 没有 fill、只有 stroke 的是线；没有 fill 也没有 stroke 的，从 .smooth.svg 按顺序取渐变。
//   - compact 里没有顶点的形状（直线、描边转成的形状），按名字从 .smooth.svg 里取路径，写成 type: "path"。
//   - 腮红（名字里有「腮红」）：透明度 0.5，模糊 2.5 × 缩放。
import fs from 'node:fs';
import path from 'node:path';

const [, , inFile, outFile, title] = process.argv;
if (!inFile || !outFile) { console.error('usage: convert.mjs in.compact.json out.chibi.json [标题]'); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const r3 = v => Math.round(v * 100) / 100;

const head = doc.parts.find(p => p.name === '头' && !p.isMask && p.pts);
const S = 100 / (head ? head.w : doc.frame[0]);
const [ox, oy] = head ? [head.m[4], head.m[5]] : [0, 0];
const T = (x, y) => [r3((x - ox) * S), r3((y - oy) * S)];
const R = r => (r < 100 ? r3(r * S) : r);

// .smooth.svg 里的线性渐变，按出现顺序
const svgFile = inFile.replace(/\.compact\.json$/, '.smooth.svg');
const grads = [], svgByName = new Map();
// .smooth.svg 和 compact 的坐标有时整体差一段（导出时画框外扩）：用同名形状的包围盒中心差，取出现最多的那个
let svgOff = [0, 0];
if (fs.existsSync(svgFile)) {
  const svg = fs.readFileSync(svgFile, 'utf8');
  const defs = new Map();
  for (const m of svg.matchAll(/<linearGradient id="([^"]+)"([^>]*)>([\s\S]*?)<\/linearGradient>/g)) {
    const a = k => Number(m[2].match(new RegExp(`${k}="([-\\d.]+)"`))?.[1] ?? 0);
    const stops = [...m[3].matchAll(/<stop([^>]*)\/>/g)].map(s => {
      const off = Number(s[1].match(/offset="([\d.]+)"/)?.[1] ?? 0);
      return [s[1].match(/stop-color="([^"]+)"/)?.[1].toLowerCase() ?? '#cccccc', off];
    });
    defs.set(m[1], { linear: [T(a('x1'), a('y1')), T(a('x2'), a('y2'))], stops });
  }
  for (const m of svg.matchAll(/fill="url\(#([^)]+)\)"/g)) if (defs.has(m[1])) grads.push(defs.get(m[1]));
  // 叶子形状按名字排队：Figma 导出的 id 是「名字」「名字_2」……，顺序和 compact 里同名部件一致
  const fix = t => { try { const u = Buffer.from(t, 'latin1').toString('utf8'); return u.includes('�') ? t : u; } catch { return t; } };
  for (const m of svg.matchAll(/<(path|rect|ellipse|circle)\b([^>]*?)\/?>/g)) {
    const id = m[2].match(/\sid="([^"]+)"/)?.[1];
    const d = m[2].match(/\sd="([^"]+)"/)?.[1];
    if (!id || !d) continue;
    const base = fix(id).replace(/_\d+$/, '');
    if (!svgByName.has(base)) svgByName.set(base, []);
    svgByName.get(base).push({ d, stroke: /\sstroke="/.test(m[2]) });
  }
  // 带滤镜的组（腮红）：<g id="右腮红" filter=…><path d=…/></g>，路径本身没有 id，记在组名下
  for (const m of svg.matchAll(/<g id="([^"]+)"[^>]*filter="[^"]*"[^>]*>\s*<path d="([^"]+)"/g)) {
    const base = fix(m[1]).replace(/_\d+$/, '');
    if (!svgByName.has(base)) svgByName.set(base, []);
    svgByName.get(base).push({ d: m[2], stroke: false });
  }
  const votes = new Map(), seen = new Map();
  const mid = arr => (Math.min(...arr) + Math.max(...arr)) / 2;
  for (const p of doc.parts) {
    if (!p.pts || p.isMask) continue;
    const k = seen.get(p.name) || 0; seen.set(p.name, k + 1);
    const sv = svgByName.get(p.name)?.[k];
    if (!sv) continue;
    const v = sv.d.match(/-?[\d.]+(?:e-?\d+)?/g).map(Number);
    const [a, b, c, dd, e, f] = p.m;
    const cp = p.pts.map(([x, y]) => [a * x + c * y + e, b * x + dd * y + f]);
    const key = `${(mid(v.filter((_, i) => i % 2 === 0)) - mid(cp.map(t => t[0]))).toFixed(1)},${(mid(v.filter((_, i) => i % 2 === 1)) - mid(cp.map(t => t[1]))).toFixed(1)}`;
    votes.set(key, (votes.get(key) || 0) + 1);
  }
  const best = [...votes].sort((x, y) => y[1] - x[1])[0];
  if (best && best[1] >= 2) svgOff = best[0].split(',').map(Number);
}

// 把 SVG 路径换算到 W=100：只认绝对坐标的 M L H V C Z（Figma 导出就是这些）
function pathToW100(d) {
  const tok = d.match(/[MLHVCZ]|-?[\d.]+(?:e-?\d+)?/g);
  let i = 0, cmd = '', x = 0, y = 0, out = '';
  const num = () => Number(tok[i++]);
  const P = (px, py) => { const [X, Y] = T(px - svgOff[0], py - svgOff[1]); return `${X} ${Y}`; };
  while (i < tok.length) {
    if (/[A-Z]/.test(tok[i])) cmd = tok[i++];
    if (cmd === 'Z') { out += 'Z'; continue; }
    if (cmd === 'M' || cmd === 'L') { x = num(); y = num(); out += `${cmd}${P(x, y)} `; }
    else if (cmd === 'H') { x = num(); out += `L${P(x, y)} `; }
    else if (cmd === 'V') { y = num(); out += `L${P(x, y)} `; }
    else if (cmd === 'C') { const v = [num(), num(), num(), num(), num(), num()]; x = v[4]; y = v[5]; out += `C${P(v[0], v[1])} ${P(v[2], v[3])} ${P(x, y)} `; }
    else i++;
  }
  return out.trim();
}

const used = new Map();
const uniq = nm => { const k = (used.get(nm) || 0) + 1; used.set(nm, k); return k === 1 ? nm : `${nm}_${k}`; };
const masks = [];   // { group, name }
const takeSvg = nm => svgByName.get(nm)?.shift();
// compact 的点没有任何圆角、但 SVG 里是曲线（Figma 的椭圆、布尔运算出来的形状）时，改用 SVG 里的路径。
function useSvgInstead(p, tf, d) {
  const noRadius = p.r === undefined && p.pts.every(pt => pt[2] === undefined);
  if (!noRadius || !/C/.test(d)) return false;
  const v = d.match(/-?[\d.]+(?:e-?\d+)?/g).map(Number);
  const sx = v.filter((_, i) => i % 2 === 0), sy = v.filter((_, i) => i % 2 === 1);
  const cp = p.pts.map(([x, y]) => { const [a, b, , , e, f] = p.m; return [a * x + p.m[2] * y + e, b * x + p.m[3] * y + f]; });
  const cx = cp.map(t => t[0]), cy = cp.map(t => t[1]);
  const mid = arr => (Math.min(...arr) + Math.max(...arr)) / 2;
  const off = Math.hypot(mid(sx) - svgOff[0] - mid(cx), mid(sy) - svgOff[1] - mid(cy));
  // 导出的 id 里中文有时被编坏，同名对不上；位置差太远就说明拿错了，不用
  return off <= 3;
}
const out = [];
for (const p of doc.parts) {
  const [a, b, c, d, e, f] = p.m;
  const tf = (x, y) => T(a * x + c * y + e, b * x + d * y + f);
  const sx = Math.hypot(a, b), sy = Math.hypot(c, d);
  const g = p.groupPath || '';
  const q = { name: uniq(p.name) };
  const svgPick = takeSvg(p.name);
  if (p.type === 'STAR') {
    const [cx, cy] = tf(p.w / 2, p.h / 2);
    Object.assign(q, { type: 'star', points: p.points, inner: p.innerRadius, cx, cy, rx: r3(p.w / 2 * sx * S), ry: r3(p.h / 2 * sy * S), r: R(p.r ?? 0) });
  } else if (p.type === 'ELLIPSE') {
    const [cx, cy] = tf(p.w / 2, p.h / 2);
    Object.assign(q, { type: 'ellipse', cx, cy, rx: r3(p.w / 2 * sx * S), ry: r3(p.h / 2 * sy * S) });
    const rot = Math.atan2(b, a) * 180 / Math.PI;
    if (Math.abs(rot) > 0.5 && Math.abs(Math.abs(rot) - 180) > 0.5) Object.assign(q, { rotate: r3(rot), cx, cy });
  } else if (!p.pts) {
    // compact 里没有顶点的形状（直线、被描边转成的形状）：用 SVG 里同名那条路径
    const sv = svgPick;
    if (sv && sv.stroke && p.stroke) Object.assign(q, { type: 'path', d: pathToW100(sv.d), stroke: p.stroke, sw: r3((p.sw ?? 1) * S) });
    else if (sv) Object.assign(q, { type: 'path', d: pathToW100(sv.d) });
    else Object.assign(q, { type: 'line', pts: [tf(0, 0), tf(p.w, 0)], stroke: p.stroke, sw: r3((p.sw ?? 1) * S) });
  } else if (p.stroke && !p.fill && svgPick && svgPick.stroke && /C/.test(svgPick.d)) {
    // 弯弯的线（蛇的弯弯嘴）：compact 只有折线顶点，曲线在 SVG 里
    Object.assign(q, { type: 'path', d: pathToW100(svgPick.d), stroke: p.stroke, sw: r3((p.sw ?? 1) * S) });
  } else if (p.stroke && !p.fill) {
    Object.assign(q, { type: 'line', pts: p.pts.map(([x, y]) => tf(x, y)), stroke: p.stroke, sw: r3((p.sw ?? 1) * S) });
  } else if (svgPick && !svgPick.stroke && useSvgInstead(p, tf, svgPick.d)) {
    Object.assign(q, { type: 'path', d: pathToW100(svgPick.d) });
  } else {
    let pts = p.pts.map(([x, y, r]) => (r === undefined ? tf(x, y) : [...tf(x, y), R(r)]));
    if (a * d - b * c < 0) pts = pts.reverse();
    q.pts = pts;
    if (p.r !== undefined) q.r = R(p.r);
    q.smooth = p.smooth ?? 0;
  }
  if (q.type !== 'line' && !(q.type === 'path' && q.stroke)) q.fill = p.fill ?? grads.shift() ?? (q.type === 'path' ? p.stroke : null) ?? '#cccccc';
  if (p.isMask) {
    q.name = uniq(`${p.name}遮罩`);
    q.hidden = true;
    masks.push({ group: g, name: q.name });
  } else {
    // 同一个 Mask group 里、排在遮罩后面的部件，用最近的那个遮罩
    const mk = [...masks].reverse().find(m => m.group && (g === m.group || g.startsWith(m.group + '/')));
    if (mk) q.clip = mk.name;
    else if (/Mask group/.test(g) && head) q.clip = '头';
  }
  // 新旧部件名都按毛色生成柔和阴影。
  if (/腮红|面部阴影/.test(p.name)) {
    const localFur = [...out].reverse().find(part => ['嘴周浅毛', '头_3', '头'].includes(part.name) && /^#[0-9a-f]{6}$/i.test(part.fill));
    const base = localFur?.fill || '#e6d9cf';
    q.fill = '#' + base.slice(1).match(/../g).map(ch => Math.round(parseInt(ch, 16) * .85).toString(16).padStart(2, '0')).join('');
    q.opacity = .45;
    q.blur = r3(2.5 * S);
  }
  out.push(q);
}

// 视框：所有点外扩 12
const xs = [], ys = [];
for (const q of out) {
  if (q.pts) for (const [x, y] of q.pts) { xs.push(x); ys.push(y); }
  if (q.d) { const v = q.d.match(/-?[\d.]+/g).map(Number); for (let k = 0; k + 1 < v.length; k += 2) { xs.push(v[k]); ys.push(v[k + 1]); } }
  if (q.cx !== undefined) { xs.push(q.cx - q.rx, q.cx + q.rx); ys.push(q.cy - q.ry, q.cy + q.ry); }
}
const x0 = Math.min(...xs) - 12, y0 = Math.min(...ys) - 12;
const side = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0) + 12;
const result = {
  schema: 'ruoruo-chibi@0.1',
  title: title || path.basename(inFile).replace(/\.compact\.json$/, ''),
  source: `若若原稿 ${path.basename(inFile)}，头宽 ${head ? head.w : doc.frame[0]} → 100（× ${r3(S)}）`,
  axis: 50,
  viewBox: [r3(x0), r3(y0), r3(side), r3(side)],
  background: '#f6f1ec',
  parts: out,
};
fs.writeFileSync(outFile, JSON.stringify(result, null, 1) + '\n', 'utf8');
console.log('wrote', outFile, `(${out.length} parts, ×${r3(S)})`);
