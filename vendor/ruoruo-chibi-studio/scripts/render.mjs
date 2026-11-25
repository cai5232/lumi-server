#!/usr/bin/env node
// 若若 Q 版小动物 · 渲染器（ruoruo-chibi@0.1）
// 用法：node render.mjs <input.chibi.json> [output.svg]
//       node render.mjs <input.chibi.json> [out.svg] --pastel   正式交付：只出油画棒版（整只套 pastel 毛毡滤镜）
//       node render.mjs <input.chibi.json> --both     自查用：光滑版 + 同名 .油画棒.svg
// 输入：chibi 格式（字段见 references/output.md「A：写 chibi JSON」，类型见 schema/ruoruo-chibi.schema.json），坐标系为头宽 W=100。
// roundedPath() 移植自若若的 Frame2Parametric.tsx（逐角半径 + corner smoothing），只去掉了 TS 类型。
import { applyViews } from './view-parts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const n = v => +v.toFixed(3);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function roundedPath(vertices, fallbackRadius, smoothing, factor = 1) {
  const count = vertices.length;
  if (count < 3) return '';
  const P = (x, y) => ({ x, y });
  const add = (a, b) => P(a.x + b.x, a.y + b.y);
  const sub = (a, b) => P(a.x - b.x, a.y - b.y);
  const mul = (a, t) => P(a.x * t, a.y * t);
  const norm = a => { const l = Math.hypot(a.x, a.y); return l > 1e-10 ? mul(a, 1 / l) : P(0, 0); };
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const clamp01 = v => clamp(v, 0, 1);
  const nums = a => n(a.x) + ' ' + n(a.y);
  const turn = (a, b) => a.x * b.y - a.y * b.x;
  const rad = vertices.map(v => Math.max(0, (v.cornerRadius ?? fallbackRadius) * Math.max(0, factor)));
  const smooth = clamp01(smoothing);
  const demands = [], edges = [];
  for (let i = 0; i < count; i++) {
    edges.push(dist(vertices[i], vertices[(i + 1) % count]));
    const here = vertices[i], prev = vertices[(i - 1 + count) % count], next = vertices[(i + 1) % count];
    const a = norm(sub(prev, here)), b = norm(sub(next, here));
    const angle = Math.acos(clamp(dot(a, b), -1, 1));
    const tan = Math.tan(angle / 2);
    const plain = tan > 1e-8 && Number.isFinite(tan) ? rad[i] / tan : 0;
    demands.push({ plain, full: plain * (1 + smooth) });
  }
  // 相邻两个角同时分摊一条边的长度
  const budgets = new Array(count).fill(Infinity);
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const a = demands[i].full, b = demands[j].full, total = a + b;
    const fraction = total > edges[i] && total > 1e-8 ? edges[i] / total : 1;
    budgets[i] = Math.min(budgets[i], a * fraction);
    budgets[j] = Math.min(budgets[j], b * fraction);
  }
  const curves = [];
  const cpath = (center, r, start, sweep) => {
    const result = [];
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    for (let j = 0; j < steps; j++) {
      const a = start + sweep * j / steps, b = start + sweep * (j + 1) / steps, k = 4 / 3 * Math.tan((b - a) / 4);
      const begin = P(center.x + r * Math.cos(a), center.y + r * Math.sin(a));
      const end = P(center.x + r * Math.cos(b), center.y + r * Math.sin(b));
      result.push({ a: add(begin, P(-r * Math.sin(a) * k, r * Math.cos(a) * k)),
                    b: sub(end, P(-r * Math.sin(b) * k, r * Math.cos(b) * k)), end });
    }
    return Math.abs(sweep) > 1e-8 ? result : [];
  };
  for (let i = 0; i < count; i++) {
    const curr = vertices[i], prev = vertices[(i - 1 + count) % count], next = vertices[(i + 1) % count];
    const inVec = norm(sub(prev, curr)), outVec = norm(sub(next, curr));
    const phi = Math.acos(clamp(dot(inVec, outVec), -1, 1));
    const tan = Math.tan(phi / 2), sin = Math.sin(phi / 2);
    const maxCut = budgets[i];
    if (rad[i] < 1e-7 || sin < 1e-7 || tan < 1e-7 || !Number.isFinite(maxCut)) {
      curves.push({ start: curr, end: curr, curves: [] }); continue;
    }
    let q = Math.max(0, rad[i] / tan), xi = smooth;
    if (q > maxCut) { q = maxCut; xi = 0; }
    else if (q * (1 + xi) > maxCut && q > 1e-8) xi = clamp01(maxCut / q - 1);
    if (q < 1e-7) { curves.push({ start: curr, end: curr, curves: [] }); continue; }
    const effectiveRadius = q * tan;
    const center = add(curr, mul(norm(add(inVec, outVec)), effectiveRadius / sin));
    const entry = add(curr, mul(inVec, q)), exit = add(curr, mul(outVec, q));
    const radial = norm(sub(entry, center));
    const startAng = Math.atan2(radial.y, radial.x);
    const radialEnd = norm(sub(exit, center));
    const endAng = Math.atan2(radialEnd.y, radialEnd.x);
    const dirIn = mul(inVec, -1);
    const ccw = turn(radial, dirIn) >= 0;
    let sweep = endAng - startAng;
    if (ccw) { while (sweep < 0) sweep += Math.PI * 2; if (sweep > Math.PI * 2 - 1e-7) sweep -= Math.PI * 2; }
    else { while (sweep > 0) sweep -= Math.PI * 2; if (sweep < -Math.PI * 2 + 1e-7) sweep += Math.PI * 2; }
    const p = q * (1 + xi);
    if (xi < 1e-7) {
      curves.push({ start: entry, end: exit, curves: cpath(center, effectiveRadius, startAng, sweep) });
      continue;
    }
    const beta = (Math.PI - phi) * xi / 2;
    const tangent = effectiveRadius * Math.tan(beta / 2);
    const ctrlSpan = (p - q + tangent) / 3;
    const shoulder = p - 2 * ctrlSpan;
    const reduced = sweep * (1 - xi);
    const arcStart = startAng + sweep / 2 - reduced / 2;
    const arcEnd = arcStart + reduced;
    const near = P(center.x + effectiveRadius * Math.cos(arcStart), center.y + effectiveRadius * Math.sin(arcStart));
    const far = P(center.x + effectiveRadius * Math.cos(arcEnd), center.y + effectiveRadius * Math.sin(arcEnd));
    void far;
    curves.push({ start: add(curr, mul(inVec, p)), end: add(curr, mul(outVec, p)), curves: [
      { a: add(curr, mul(inVec, shoulder)), b: add(curr, mul(inVec, q - tangent)), end: near },
      ...cpath(center, effectiveRadius, arcStart, reduced),
      { a: add(curr, mul(outVec, q - tangent)), b: add(curr, mul(outVec, shoulder)), end: add(curr, mul(outVec, p)) }
    ] });
  }
  let d = 'M ' + nums(curves[0].end);
  for (let i = 0; i < count; i++) {
    const c = curves[(i + 1) % count];
    d += ' L ' + nums(c.start);
    for (const bez of c.curves) d += ' C ' + nums(bez.a) + ' ' + nums(bez.b) + ' ' + nums(bez.end);
  }
  return d + ' Z';
}

// ---------- chibi 格式 → SVG ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toPts = arr => arr.map(a => ({ x: a[0], y: a[1], cornerRadius: a[2] }));

// 镜像：x → 2*axis - x，并反转顶点顺序保持绕向
function mirrorPart(p, axis) {
  const q = structuredClone(p);
  q.name = p.mirrorName || p.name;
  if (p.mirrorGroup) q.group = p.mirrorGroup;
  delete q.mirror; delete q.mirrorName; delete q.mirrorGroup;
  if (q.pts) q.pts = q.pts.map(([x, y, r]) => (r === undefined ? [2 * axis - x, y] : [2 * axis - x, y, r])).reverse();
  if (q.d) q.d = q.d.replace(/([MLC])([^MLCZ]*)/g, (_, c, s) => c + s.trim().split(/[\s,]+/).map((v, i) => (i % 2 ? v : String(+(2 * axis - v).toFixed(2)))).join(' ') + ' ');
  if (q.cx !== undefined) q.cx = 2 * axis - q.cx;
  if (q.fill?.radial) q.fill.radial[0] = 2 * axis - q.fill.radial[0];
  if (q.fill && q.fill.linear) q.fill.linear = q.fill.linear.map(([x, y]) => [2 * axis - x, y]);
  if (q.rotate) q.rotate = -q.rotate;
  return q;
}

export function expand(doc) {
  const axis = doc.axis ?? 50;
  const out = [];
  for (const p of doc.parts) {
    if (p.mirror === 'before') { out.push(mirrorPart(p, axis)); out.push(p); }
    else if (p.mirror) { out.push(p); out.push(mirrorPart(p, axis)); }
    else out.push(p);
  }
  return out;
}

// 开放折线：中间顶点可带圆角 [x, y, r]，不写 r 的保持尖角
function roundedPolyline(pts) {
  const P = pts.map(a => ({ x: a[0], y: a[1], r: a[2] || 0 }));
  const m = P.length;
  const edge = [];
  for (let i = 0; i < m - 1; i++) edge.push(dist(P[i], P[i + 1]));
  // 每个角想要切掉多长（切点到顶点的距离 q = r / tan(夹角/2)）；两端点和没写 r 的角是 0
  const info = P.map((cur, i) => {
    if (i === 0 || i === m - 1 || !cur.r || edge[i - 1] < 1e-9 || edge[i] < 1e-9) return null;
    const prev = P[i - 1], next = P[i + 1], l1 = edge[i - 1], l2 = edge[i];
    const u1 = { x: (prev.x - cur.x) / l1, y: (prev.y - cur.y) / l1 };
    const u2 = { x: (next.x - cur.x) / l2, y: (next.y - cur.y) / l2 };
    const phi = Math.acos(clamp(u1.x * u2.x + u1.y * u2.y, -1, 1));
    const tan = Math.tan(phi / 2);
    if (tan < 1e-6 || !Number.isFinite(tan)) return null;
    return { u1, u2, tan, want: cur.r / tan };
  });
  // 按一条边两端的实际需要分边长：只有一端要磨圆就整条边都给它；两端加起来放不下再按比例缩
  const q = info.map(t => (t ? t.want : 0));
  for (let i = 0; i < m - 1; i++) {
    const a = q[i], b = q[i + 1], total = a + b;
    if (total > edge[i] && total > 1e-9) {
      const k = edge[i] / total;
      if (info[i]) q[i] = Math.min(q[i], a * k);
      if (info[i + 1]) q[i + 1] = Math.min(q[i + 1], b * k);
    }
  }
  let d = 'M ' + n(P[0].x) + ' ' + n(P[0].y);
  for (let i = 1; i < m - 1; i++) {
    const cur = P[i], t = info[i];
    if (!t || q[i] < 1e-7) { d += ' L ' + n(cur.x) + ' ' + n(cur.y); continue; }
    const rr = q[i] * t.tan; // 实际半径
    const a = { x: cur.x + t.u1.x * q[i], y: cur.y + t.u1.y * q[i] };
    const b = { x: cur.x + t.u2.x * q[i], y: cur.y + t.u2.y * q[i] };
    // 用真正的圆弧，两端和原来的直线相切。行进方向从 -u1 转到 u2，叉积 > 0 是顺时针（y 向下），sweep = 1
    const cross = (-t.u1.x) * t.u2.y - (-t.u1.y) * t.u2.x;
    d += ' L ' + n(a.x) + ' ' + n(a.y) + ' A ' + n(rr) + ' ' + n(rr) + ' 0 0 ' + (cross > 0 ? 1 : 0) + ' ' + n(b.x) + ' ' + n(b.y);
  }
  const last = P[m - 1];
  return d + ' L ' + n(last.x) + ' ' + n(last.y);
}

// 星形（刺猬的刺）：外顶点在 rx/ry 的椭圆上、内顶点缩到 inner 倍，第一个尖朝正上方，和 Figma 的 Star 一样
function starPts(p) {
  const N = p.points ?? 5, inner = p.inner ?? 0.5, out = [];
  for (let k = 0; k < 2 * N; k++) {
    const a = -Math.PI / 2 + k * Math.PI / N, s = k % 2 ? inner : 1;
    out.push([n(p.cx + p.rx * s * Math.cos(a)), n(p.cy + p.ry * s * Math.sin(a))]);
  }
  return out;
}

function shapeD(p) {
  if (p.type === 'line') return roundedPolyline(p.pts);
  if (p.type === 'star') return roundedPath(toPts(starPts(p)), p.r ?? 0, p.smooth ?? 0.6);
  if (p.type === 'path') return p.d;   // 原样的 SVG 路径（模板里少数没有顶点数据的形状），坐标已在 W=100 里
  return roundedPath(toPts(p.pts), p.r ?? 0, p.smooth ?? 0.6);
}

// ---------- 翻折 ----------
// 部件写 fold: { line: [[x1,y1],[x2,y2]], keep: [x,y], r }：沿折线把多边形切成两半，只留 keep 那侧（不写 keep 就留下面那侧）。
// 折线上新长出来的两个角用 r（默认 2）磨圆。
// 另写一个 { type: "flap", of: "右耳外", fill } 放在想要的图层位置：它是被折掉的那半沿折线翻过来，露出耳朵背面。
// 先切再磨圆角，所以翻片的边也是圆的；之后照常 mirror。
function splitByLine(pts, f, fallbackR) {
  const [[x1, y1], [x2, y2]] = f.line;
  let nx = -(y2 - y1), ny = x2 - x1;
  const keep = f.keep || [(x1 + x2) / 2, (y1 + y2) / 2 + 1e4];
  if (nx * (keep[0] - x1) + ny * (keep[1] - y1) < 0) { nx = -nx; ny = -ny; }
  const side = ([x, y]) => nx * (x - x1) + ny * (y - y1);
  const fr = f.r ?? 2, keepP = [], dropP = [], cuts = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], sa = side(a), sb = side(b);
    (sa >= 0 ? keepP : dropP).push(a.length > 2 ? a : [a[0], a[1], fallbackR]);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb), c = [n(a[0] + (b[0] - a[0]) * t), n(a[1] + (b[1] - a[1]) * t), fr];
      keepP.push(c); dropP.push(c); cuts.push(c);
    }
  }
  // 关于折线做镜像，并反转顶点顺序保持绕向（折线上的切点镜像后不动，仍是同一个数组对象）
  const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  const refl = p => {
    if (cuts.includes(p)) return p;
    const [x, y, r] = p, t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / l2, px = x1 + t * (x2 - x1), py = y1 + t * (y2 - y1);
    return [n(2 * px - x), n(2 * py - y), r];
  };
  let flap = dropP.map(refl).reverse();
  // bend：翻片的折痕那条边鼓成圆弧，往外（翻片身子的反方向）鼓 bend 这么高，像耳朵卷过来的圆背。
  // 鼓出来的那块盖在留下的半截上面，所以留下的半截不用改。
  const bend = f.bend ?? 0;
  if (bend && cuts.length === 2) {
    const i = flap.indexOf(cuts[0]), j = flap.indexOf(cuts[1]), L = flap.length;
    let s, e, at;
    if ((i + 1) % L === j) { s = cuts[0]; e = cuts[1]; at = i + 1; }
    else { s = cuts[1]; e = cuts[0]; at = j + 1; }
    const mx = (s[0] + e[0]) / 2, my = (s[1] + e[1]) / 2, half = Math.hypot(e[0] - s[0], e[1] - s[1]) / 2;
    const R = (half * half + bend * bend) / (2 * bend);           // 过两切点、拱高 bend 的圆
    const ox = mx + nx / Math.hypot(nx, ny) * (R - bend), oy = my + ny / Math.hypot(nx, ny) * (R - bend); // 圆心在留下那侧
    const a0 = Math.atan2(s[1] - oy, s[0] - ox);
    let da = Math.atan2(e[1] - oy, e[0] - ox) - a0;
    const apexA = Math.atan2(-ny, -nx);                            // 拱顶朝外
    const mid = a => { let d = a - a0; while (d < -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI; return d; };
    if (Math.abs(mid(apexA) - da / 2) > Math.abs(mid(apexA) - (da > 0 ? da - 2 * Math.PI : da + 2 * Math.PI) / 2)) da = da > 0 ? da - 2 * Math.PI : da + 2 * Math.PI;
    const K = 10, arc = [];
    for (let k = 1; k < K; k++) { const a = a0 + da * k / K; arc.push([n(ox + R * Math.cos(a)), n(oy + R * Math.sin(a)), 1000]); }
    flap = [...flap.slice(0, at), ...arc, ...flap.slice(at)];
  }
  return { keep: keepP, flap };
}

function applyFolds(parts) {
  const byName = new Map(parts.map(p => [p.name, p]));
  const cut = new Map();
  for (const p of parts) if (p.fold) {
    if (!p.pts) throw new Error(`fold 只能用在多边形部件上：${p.name}`);
    cut.set(p.name, splitByLine(p.pts, p.fold, p.r));
  }
  return parts.map(p => {
    if (p.type === 'flap') {
      const src = byName.get(p.of), c = cut.get(p.of);
      if (!src || !c) throw new Error(`flap.of 要指向一个带 fold 的部件：${p.of}`);
      const { name, fill, mirror, mirrorName, mirrorGroup, opacity, clip } = p;
      const q = { ...src, pts: c.flap, name, fill: fill ?? src.fill };
      delete q.fold; delete q.type;
      for (const [k, v] of Object.entries({ mirror, mirrorName, mirrorGroup, opacity, clip })) {
        if (v === undefined) delete q[k]; else q[k] = v;
      }
      return q;
    }
    if (p.fold) { const q = { ...p, pts: cut.get(p.name).keep }; delete q.fold; return q; }
    return p;
  });
}

// 姿势组：pose = { 组名: { rotate, cx, cy, dx, dy, parent } }。
// 部件写 group 归组；效果是：部件自己先转 → 绕本组转轴转 → 本组平移 → 再套父组。
// 转轴一律写在站正时的坐标里。
function groupTf(name, pose, seen = new Set()) {
  if (!name || !pose || !pose[name]) return '';
  if (seen.has(name)) throw new Error(`pose 组循环引用：${name}`);
  seen.add(name);
  const g = pose[name];
  let t = groupTf(g.parent, pose, seen);
  if (g.dx || g.dy) t += ` translate(${n(g.dx ?? 0)} ${n(g.dy ?? 0)})`;
  if (g.rotate) t += ` rotate(${g.rotate} ${n(g.cx ?? 0)} ${n(g.cy ?? 0)})`;
  return t;
}

function shapeEl(p, extra = '', pose) {
  let t = groupTf(p.group, pose);
  if (p._tailMatrix) t = "matrix(" + p._tailMatrix.map(n).join(" ") + ") " + t;
  if (p._surfaceMatrix) t += " matrix(" + p._surfaceMatrix.map(n).join(" ") + ")";
  if (p.rotate) t += ` rotate(${p.rotate} ${n(p.cx ?? 0)} ${n(p.cy ?? 0)})`;
  const tf = t ? ` transform="${t.trim()}"` : "";
  if (p._shadowPaths) return '<g'+tf+extra+'>'+p._shadowPaths.map(d=>'<path d="'+d+'"/>').join('')+'</g>';
  if (p.type === 'ellipse') {
    return `<ellipse cx="${n(p.cx)}" cy="${n(p.cy)}" rx="${n(p.rx)}" ry="${n(p.ry)}"${tf}${extra}/>`;
  }
  return `<path d="${shapeD(p)}"${tf}${extra}/>`;
}

const clipKey = c => (c ? (Array.isArray(c) ? c.join('+') : c) : '');

// ---------- 蕾丝：一圈拱形，贴着头排，两边小中间大 ----------
// 把 path 的 M/L/C 压成折线
function flatten(d) {
  const tok = d.match(/[MLCZ]|-?[\d.]+(?:e-?\d+)?/g) || [];
  let i = 0, cur = null; const out = [];
  const num = () => +tok[i++];
  while (i < tok.length) {
    const c = tok[i++];
    if (c === 'M' || c === 'L') { cur = [num(), num()]; out.push(cur); }
    else if (c === 'C') {
      const a = [num(), num()], b = [num(), num()], e = [num(), num()];
      for (let k = 1; k <= 12; k++) {
        const t = k / 12, u = 1 - t;
        out.push([u * u * u * cur[0] + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t * t * t * e[0],
                  u * u * u * cur[1] + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t * t * t * e[1]]);
      }
      cur = e;
    }
  }
  return out;
}
// 部件在站正时的轮廓（含自己的 rotate，不含 pose）
function outlineOf(p) {
  let pts;
  if (p.type === 'ellipse') {
    pts = Array.from({ length: 72 }, (_, k) => [p.cx + p.rx * Math.cos(k * Math.PI / 36), p.cy + p.ry * Math.sin(k * Math.PI / 36)]);
  } else pts = flatten(shapeD(p));
  if (p.rotate) {
    const a = p.rotate * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), ox = p.cx ?? 0, oy = p.cy ?? 0;
    pts = pts.map(([x, y]) => [ox + (x - ox) * cs - (y - oy) * sn, oy + (x - ox) * sn + (y - oy) * cs]);
  }
  return pts;
}
// 从中心往外放射 360 根线，取几个部件里最远的交点 = 它们合起来的外轮廓。角度 0 = 正上方，顺时针为正
function unionRing(polys, c) {
  const ring = [];
  for (let k = 0; k < 360; k++) {
    const ang = (k - 180) * Math.PI / 180, dx = Math.sin(ang), dy = -Math.cos(ang);
    let best = 0;
    for (const poly of polys) for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], ex = b[0] - a[0], ey = b[1] - a[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a[0] - c[0]) * ey - (a[1] - c[1]) * ex) / den, u = ((a[0] - c[0]) * dy - (a[1] - c[1]) * dx) / den;
      if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
    }
    ring.push([c[0] + best * dx, c[1] + best * dy]);
  }
  return ring; // ring[180] 在正上方
}
// 沿折线走 s 的距离，返回点和朝外的法线
function walkAt(pts, s, c) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + l >= s || i === pts.length - 1) {
      const t = l > 1e-9 ? clamp((s - acc) / l, 0, 1) : 0;
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      let nx = (b[1] - a[1]) / (l || 1), ny = -(b[0] - a[0]) / (l || 1);
      if (nx * (x - c[0]) + ny * (y - c[1]) < 0) { nx = -nx; ny = -ny; }
      return { x, y, nx, ny };
    }
    acc += l;
  }
}
// type: "lace" 展开成一组拱形 + 小圆点。参数见 SKILL.md 字段表
function expandLace(p, byName) {
  const names = p.along || ['头'];
  const polys = names.map(nm => {
    const src = byName.get(nm);
    if (!src) throw new Error(`lace.along 指向不存在的部件：${nm}`);
    return outlineOf(src);
  });
  const c = p.center || [50, 40];
  const ring = unionRing(polys, c);
  const right = ring.slice(180).concat([ring[0]]), left = ring.slice(0, 181).reverse();
  const N = p.count ?? 9, top = p.top || [22, 17], end = p.end || [11, 10];
  const gap = p.gap ?? 0.68, inset = p.inset ?? 0.3, tuck = p.tuck ?? 10;
  const size = k => { const t = N > 1 ? k / (N - 1) : 0; return [top[0] + (end[0] - top[0]) * t, top[1] + (end[1] - top[1]) * t]; };
  const blocks = [];
  for (const [side, pts] of [[1, right], [-1, left]]) {
    let s = 0;
    for (let k = 0; k < N; k++) {
      if (side === -1 && k === 0) continue; // 正上方那块只画一次
      const [w, h] = size(k);
      if (k) s += gap * (size(k - 1)[0] + w) / 2;
      const q = walkAt(pts, s, c);
      const cx = q.x + q.nx * inset * h, cy = q.y + q.ny * inset * h;
      const rot = k === 0 ? 0 : Math.atan2(q.nx, -q.ny) * 180 / Math.PI;
      blocks.push({ k, w, h, cx, cy, rot });
    }
  }
  blocks.sort((a, b) => b.k - a.k); // 两侧小的先画，正上方大的最后画、压在上面
  const base = { group: p.group, smooth: p.smooth ?? 0.6 };
  const arches = blocks.map((b, i) => ({
    ...base, name: `${p.name}${i + 1}`, fill: p.fill || '#ffffff', rotate: n(b.rot), cx: n(b.cx), cy: n(b.cy),
    // 拱形 = 胶囊切掉一半：上面三个角圆到底，底边两个角小圆角；底边往里多伸 tuck 藏到头后面
    pts: [[-b.w / 2, b.h / 2 + tuck, 1.2], [-b.w / 2, -b.h / 2 + b.w / 2, 1000], [0, -b.h / 2, 1000],
          [b.w / 2, -b.h / 2 + b.w / 2, 1000], [b.w / 2, b.h / 2 + tuck, 1.2]].map(([x, y, r]) => [n(b.cx + x), n(b.cy + y), r])
  }));
  const dots = p.dot === false ? [] : blocks.map((b, i) => {
    const r = n((p.dotScale ?? 0.06) * b.w + 0.2);
    return { ...base, name: `${p.name}点${i + 1}`, type: 'ellipse', fill: p.dot || '#ead0dc', cx: n(b.cx), cy: n(b.cy), rx: r, ry: r };
  });
  return arches.concat(dots);
}

// type: "band" 展开成一道贴着头的月牙带：中间粗、两端细到 0，两端和头的轮廓相切
function expandBand(p, byName) {
  const names = p.along || ['头'];
  const polys = names.map(nm => {
    const src = byName.get(nm);
    if (!src) throw new Error(`band.along 指向不存在的部件：${nm}`);
    return outlineOf(src);
  });
  const c = p.center || [50, 40];
  const ring = unionRing(polys, c); // ring[180 + 角度] = 这个角度上的轮廓点
  const span = Math.round(p.span ?? 80), width = p.width ?? 4.5, ease = p.ease ?? 1.4, tuck = p.tuck ?? 6;
  const outer = [], inner = [];
  for (let a = -span; a <= span; a++) {
    const [x, y] = ring[180 + a], d = Math.hypot(x - c[0], y - c[1]) || 1, ux = (x - c[0]) / d, uy = (y - c[1]) / d;
    const w = width * Math.pow(Math.cos(Math.PI / 2 * a / span), ease); // 中间最宽，两端为 0，所以两端和头相切
    outer.push([n(x + ux * w), n(y + uy * w)]);
    inner.push([n(x - ux * tuck), n(y - uy * tuck)]); // 内缘藏进头里
  }
  const { type, along, center, span: _s, width: _w, ease: _e, tuck: _t, ...rest } = p;
  return [{ ...rest, r: 0, pts: outer.concat(inner.reverse()) }];
}

// ---------- 背景与画面装饰 ----------
// blob：涂鸦一样的不规则色块（背景蒙版）；halftone：网点；sparkle：十字星；doodle：一个小涂鸦；scatter：一圈小涂鸦围着角色。
// 都展开成普通部件（圆角多边形、填充 path、圆头描边 path），clip、opacity、图层顺序照常用。线条一律圆头圆角。
function rng(seed) {
  let a = (seed ?? 1) >>> 0 || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const segD = (pts, close) => 'M ' + pts.map(([x, y]) => n(x) + ' ' + n(y)).join(' L ') + (close ? ' Z' : '');
// 一个小涂鸦的形状（以 0,0 为中心、大小 s）：{ segs, closed, filled }
function doodleShape(kind, s, o = {}) {
  const N = 64, R = [...Array(N + 1).keys()].map(i => i / N);
  const circle = R.map(t => [Math.cos(t * 2 * Math.PI) * s / 2, Math.sin(t * 2 * Math.PI) * s / 2]);
  switch (kind) {
    case 'spiral': return { segs: [R.map(t => { const a = t * 2.3 * 2 * Math.PI; return [Math.cos(a) * s / 2 * t, Math.sin(a) * s / 2 * t]; })] };
    case 'curl': { // 彩带圈圈，像连写的 e
      const a = s * 0.09, b = s * 0.22, U = 4 * Math.PI;
      return { segs: [R.map(t => { const u = t * U; return [a * u - b * Math.sin(u) - a * U / 2, -b * Math.cos(u)]; })] };
    }
    case 'squiggle': return { segs: [R.map(t => [(t - 0.5) * s, Math.sin(t * 2.5 * 2 * Math.PI) * s * 0.14])] };
    case 'heart': case 'heartLine': { // 圆润的心：两个鼓包圆到底，下尖和中间凹口都带圆角，不尖
      const h = s / 2, tip = o.tipR ?? 0.16, notch = o.notchR ?? 0.12;
      const pts = [[0, h * 0.86, s * tip], [-h * 0.98, -h * 0.04, 200], [-h * 0.62, -h * 0.74, 200], [0, -h * 0.42, s * notch],
        [h * 0.62, -h * 0.74, 200], [h * 0.98, -h * 0.04, 200]];
      return { pts, filled: kind === 'heart', outline: kind === 'heartLine' };
    }
    case 'plus': return { segs: [[[-s / 2, 0], [s / 2, 0]], [[0, -s / 2], [0, s / 2]]] };
    case 'cross': return { segs: [[[-s / 2, -s / 2], [s / 2, s / 2]], [[-s / 2, s / 2], [s / 2, -s / 2]]] };
    case 'dash': return { segs: [[[-s / 2, 0], [s / 2, 0]]] };
    case 'burst': return { segs: [-32, 0, 32].map(d => { const a = (d - 90) * Math.PI / 180; return [[Math.cos(a) * s * 0.15, Math.sin(a) * s * 0.15 + s / 2], [Math.cos(a) * s * 0.55, Math.sin(a) * s * 0.55 + s / 2]]; }) };
    case 'tri': return { segs: [[[0, -s / 2], [s * 0.45, s * 0.35], [-s * 0.45, s * 0.35]]], closed: true };
    case 'ring': return { segs: [circle], closed: true };
    case 'dot': return { segs: [circle], closed: true, filled: true };
    case 'sparkle': { // 十字星：8 个点，4 个尖（小圆角）+ 4 个腰（大圆角），边是直的往里收
      // 腰收得很细、腰角只磨一点点，四个尖才尖、不胖
      const waist = s * (o.waist ?? 0.1);
      const pts = [...Array(8).keys()].map(i => { const a = (i * 45 - 90) * Math.PI / 180, d = i % 2 ? waist : s / 2; return [Math.cos(a) * d, Math.sin(a) * d, i % 2 ? s * (o.waistR ?? 0.07) : s * (o.tipR ?? 0.012)]; });
      return { pts, filled: true };
    }
    case 'star': case 'starLine': { // 圆润的五角星：5 个尖 + 5 个凹，尖和凹都磨圆
      const ro = s / 2, ri = ro * (o.inner ?? 0.5);
      const pts = [...Array(10).keys()].map(i => { const a = (i * 36 - 90) * Math.PI / 180, d = i % 2 ? ri : ro; return [Math.cos(a) * d, Math.sin(a) * d, i % 2 ? s * (o.innerR ?? 0.05) : s * (o.tipR ?? 0.07)]; });
      return { pts, filled: kind === 'star', outline: kind === 'starLine' };
    }
    case 'note': { // 双八分音符：两个音符头 + 两根竖杆 + 一道横梁
      const r = s * 0.12, h1 = [-s * 0.24, s * 0.3], h2 = [s * 0.26, s * 0.2], t1 = -s * 0.36, t2 = -s * 0.46;
      const head = ([x, y]) => R.map(t => [x + Math.cos(t * 2 * Math.PI) * r, y + Math.sin(t * 2 * Math.PI) * r]);
      return { segs: [head(h1), head(h2), [[h1[0] + r, h1[1]], [h1[0] + r, t1], [h2[0] + r, t2], [h2[0] + r, h2[1]]]] };
    }
    case 'confetti': // 一小撮彩色糖针：几道方向不同的短线
      return { segs: [[-0.3, -0.22, 35], [0.26, -0.3, -50], [0.32, 0.22, 70], [-0.18, 0.32, -15]].map(([x, y, d]) => { const a = d * Math.PI / 180, l = s * 0.15; return [[x * s - Math.cos(a) * l, y * s - Math.sin(a) * l], [x * s + Math.cos(a) * l, y * s + Math.sin(a) * l]]; }) };
    default: throw new Error(`doodle 不认识的 kind：${kind}`);
  }
}
function doodlePart(base, kind, cx, cy, s, rot, color, sw) {
  const sh = doodleShape(kind, s, base), a = (rot || 0) * Math.PI / 180, c = Math.cos(a), si = Math.sin(a);
  const { type: _t0, kind: _k0, size: _s0, rot: _r0, cx: _x0, cy: _y0, sw: _w0, stroke: _st0, fill: _f0, waist: _wa0, waistR: _wr0, tipR: _tr0, ...rest0 } = base;
  if (sh.pts) {
    const pts = sh.pts.map(([x, y, r]) => [n(cx + x * c - y * si), n(cy + x * si + y * c), n(r)]);
    const { notchR: _nr0, inner: _in0, innerR: _ir0, ...r1 } = rest0;
    return sh.outline ? { ...r1, pts, smooth: base.smooth ?? 0.6, fill: 'none', stroke: color, sw: sw ?? 1.6, _deco: true }
      : { ...r1, pts, smooth: base.smooth ?? 0.6, fill: color, _deco: true };
  }
  const d = sh.segs.map(seg => segD(seg.map(([x, y]) => [cx + x * c - y * si, cy + x * si + y * c]), sh.closed)).join(' ');
  const { type, kind: _k, size: _s, rot: _r, cx: _x, cy: _y, sw: _w, stroke: _st, fill: _f, ...rest } = base;
  const { waist: _a, waistR: _b, tipR: _c, notchR: _d, ...rest2 } = rest;
  return sh.filled ? { ...rest2, type: 'path', d, fill: color, _deco: true } : { ...rest2, type: 'path', d, stroke: color, sw: sw ?? 1.6, _deco: true };
}
function expandDeco(p, doc, shapes) {
  const vb = doc.viewBox || [-30, -60, 160, 200];
  if (p.type === 'blob') {
    // { type: "blob", cx, cy, rx, ry, lobes: 9, wobble: 0.18, seed, fill }：一圈抖动的顶点 + 大圆角
    const R = rng(p.seed), N = p.lobes ?? 9, w = p.wobble ?? 0.18, pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i + (R() - 0.5) * 0.5) / N * 2 * Math.PI, k = 1 + w * (R() * 2 - 1);
      // rot：整块绕中心转多少度（先按 rx ry 画好再转），斜着的色块不死板
      const x = Math.cos(a) * p.rx * k, y = Math.sin(a) * p.ry * k, t = (p.rot || 0) * Math.PI / 180;
      pts.push([n(p.cx + x * Math.cos(t) - y * Math.sin(t)), n(p.cy + x * Math.sin(t) + y * Math.cos(t))]);
    }
    const { type, cx, cy, rx, ry, lobes, wobble, seed, rot, ...rest } = p;
    return [{ ...rest, pts, r: p.r ?? 200, _deco: true }];
  }
  if (p.type === 'halftone') {
    // { type: "halftone", area: [x,y,w,h]（默认整张画布）, gap: 4, size: 最大点半径, center + radius 或 from + to, gamma, fill, clip }
    // 点从 from 往 to 越来越小，小到看不见就不画
    // patch: [cx, cy, r] 一片圆形网点（写 [cx, cy, rx, ry] 就是椭圆）：里面是实的大点，最外面 edge（0–1）那一圈点很快变小散掉。
    //   grid: "square"（默认，方格转 45°，像网点笔刷）或 "hex"；angle 网格转多少度
    const [ax, ay, aw, ah] = p.patch ? [p.patch[0] - p.patch[2], p.patch[1] - (p.patch[3] ?? p.patch[2]), 2 * p.patch[2], 2 * (p.patch[3] ?? p.patch[2])] : p.area || vb;
    const g = p.gap ?? 4, big = p.size ?? g * 0.42, gm = p.gamma ?? 1;
    const [fx, fy] = p.from || [ax, ay], [tx, ty] = p.to || [ax + aw, ay + ah], L2 = (tx - fx) ** 2 + (ty - fy) ** 2 || 1;
    const hex = p.grid === 'hex' || (!p.patch && !p.grid);
    const ang = (p.angle ?? (hex ? 0 : 45)) * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
    const ox = ax + aw / 2, oy = ay + ah / 2, half = Math.hypot(aw, ah) / 2 + g;
    const cells = [];
    if (hex && !p.angle) { for (let j = 0, y = ay; y <= ay + ah; j++, y += g * 0.866) for (let x = ax + (j % 2) * g / 2; x <= ax + aw; x += g) cells.push([x, y]); }
    else for (let v = -half; v <= half; v += hex ? g * 0.866 : g) for (let u = -half + (hex && Math.round(v / (g * 0.866)) % 2 ? g / 2 : 0); u <= half; u += g) {
      const x = ox + u * ca - v * sa, y = oy + u * sa + v * ca;
      if (x >= ax && x <= ax + aw && y >= ay && y <= ay + ah) cells.push([x, y]);
    }
    let d = '';
    for (const [x, y] of cells) {
      // patch：椭圆里实、边上一圈散；center + radius：从中心往外一圈圈变小；from/to：沿一条线变小
      let t;
      if (p.patch) { const e = p.edge ?? 0.4, q = Math.hypot((x - p.patch[0]) / p.patch[2], (y - p.patch[1]) / (p.patch[3] ?? p.patch[2])); t = clamp((q - (1 - e)) / e, 0, 1); }
      else t = p.center ? clamp(Math.hypot(x - p.center[0], y - p.center[1]) / (p.radius ?? 40), 0, 1)
        : p.from || p.to ? clamp(((x - fx) * (tx - fx) + (y - fy) * (ty - fy)) / L2, 0, 1) : 0;
      const r = big * (1 - t) ** gm;
      if (r < 0.2) continue;
      d += `M ${n(x - r)} ${n(y)} a ${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0 a ${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0 `;
    }
    const { type, area, gap, size, from, to, gamma, center, radius, patch, edge, grid, angle, ...rest } = p;
    return [{ ...rest, type: 'path', d: d.trim(), fill: p.fill || '#ffffff', _deco: true }];
  }
  if (p.type === 'sparkle' || p.type === 'doodle') {
    // { type: "doodle", kind: "spiral|curl|squiggle|heart|heartLine|plus|cross|dash|burst|tri|ring|dot|sparkle", cx, cy, size, rot, fill 或 stroke, sw }
    const kind = p.type === 'sparkle' ? 'sparkle' : p.kind;
    return [doodlePart(p, kind, p.cx, p.cy, p.size ?? 8, p.rot, p.fill || p.stroke || '#ffffff', p.sw)];
  }
  if (p.type === 'scatter' && (p.around || p.orbit)) {
    // 轨迹撒：沿着角色外面一圈走，等距放，再随机散开一点。
    //   around: ["头","身体",…] 贴着这些部件合起来的外轮廓、往外推 dist；或 orbit: [cx, cy, rx, ry] 一个椭圆轨道
    //   from / to：从哪个角度走到哪个角度（0 = 正上方，顺时针；默认 0–360 一整圈）
    //   jitter: [沿轨道, 离轨道] 散开多少；kindsInOrder / colorsInOrder：按顺序轮着用，不随机
    const R = rng(p.seed), c = p.center || (p.orbit ? p.orbit.slice(0, 2) : [50, 60]);
    let ring;
    if (p.orbit) { const [ox, oy, rx, ry] = p.orbit; ring = Array.from({ length: 360 }, (_, k) => { const a = (k - 180) * Math.PI / 180; return [ox + rx * Math.sin(a), oy - ry * Math.cos(a)]; }); }
    else {
      const polys = [].concat(p.around).map(nm => { const src = shapes.get(nm); if (!src) throw new Error(`scatter.around 指向不存在的部件：${nm}`); return outlineOf(src); });
      const dd = p.dist ?? 10;
      ring = unionRing(polys, c).map(([x, y]) => { const dx = x - c[0], dy = y - c[1], l = Math.hypot(dx, dy) || 1; return [x + dx / l * dd, y + dy / l * dd]; });
    }
    const at = deg => ring[((Math.round(deg) % 360) + 360 + 180) % 360];
    const a0 = p.from ?? 0, a1 = p.to ?? 360, full = Math.abs(a1 - a0) >= 360;
    const steps = 720, pts = [], acc = [0];
    for (let i = 0; i <= steps; i++) pts.push(at(a0 + (a1 - a0) * i / steps));
    for (let i = 1; i <= steps; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = acc[steps], N = p.count ?? 12, jit = [].concat(p.jitter ?? [4, 5]), j1 = jit[0], j2 = jit[1] ?? jit[0];
    const kinds = p.kinds || ['sparkle', 'curl', 'plus', 'heart', 'dot', 'burst', 'spiral', 'heartLine', 'ring'];
    const colors = p.colors || ['#ffb3c7', '#9fd3ff', '#ffd36e'];
    const [s0, s1] = p.size || [5, 9], out = [];
    for (let i = 0; i < N; i++) {
      const sl = clamp((full ? (i + 0.5) / N : N > 1 ? i / (N - 1) : 0.5) * L + (R() - 0.5) * 2 * j1, 0, L);
      let k = acc.findIndex(v => v >= sl); if (k < 1) k = 1;
      const [x0, y0] = pts[k], dx = x0 - c[0], dy = y0 - c[1], l = Math.hypot(dx, dy) || 1, off = (R() - 0.5) * 2 * j2;
      const x = x0 + dx / l * off, y = y0 + dy / l * off;
      const kind = p.kindsInOrder ? kinds[i % kinds.length] : kinds[Math.floor(R() * kinds.length)];
      const col = p.colorsInOrder ? colors[i % colors.length] : colors[Math.floor(R() * colors.length)];
      const sz = s0 + R() * (s1 - s0), rot = /^(sparkle|heart|heartLine|star|starLine|note)$/.test(kind) ? (R() - 0.5) * 40 : (R() - 0.5) * 120;
      const q = { name: `${p.name}${i + 1}` };
      for (const key of ['opacity', 'clip', 'sticker']) if (p[key] !== undefined) q[key] = p[key];
      out.push(doodlePart(q, kind, x, y, kind === 'dot' ? sz * 0.35 : sz, rot, col, p.sw));
    }
    return out;
  }
  if (p.type === 'scatter') {
    // 一圈小涂鸦围着角色：{ type: "scatter", keep: [cx, cy, rx, ry]（中间留空的椭圆）, area, count, kinds, colors, size: [5, 9], sw, gap, seed, opacity }
    const R = rng(p.seed), [kx, ky, krx, kry] = p.keep || [50, 60, 55, 65];
    const [ax, ay, aw, ah] = p.area || [vb[0] + 4, vb[1] + 4, vb[2] - 8, vb[3] - 8];
    const kinds = p.kinds || ['sparkle', 'curl', 'plus', 'heart', 'dot', 'burst', 'tri', 'squiggle', 'spiral', 'dash'];
    const colors = p.colors || ['#ffd36e', '#9fd3ff', '#ffb3c7', '#c7b8ff', '#b8eab0'];
    const [s0, s1] = p.size || [5, 9], gap = p.gap ?? 10, placed = [], out = [];
    for (let tries = 0; placed.length < (p.count ?? 24) && tries < 4000; tries++) {
      const x = ax + R() * aw, y = ay + R() * ah;
      if (((x - kx) / krx) ** 2 + ((y - ky) / kry) ** 2 < 1) continue;
      if (placed.some(([px, py]) => Math.hypot(px - x, py - y) < gap)) continue;
      placed.push([x, y]);
      const kind = kinds[Math.floor(R() * kinds.length)], col = colors[Math.floor(R() * colors.length)];
      const s = s0 + R() * (s1 - s0), rot = kind === 'sparkle' || kind === 'heart' ? (R() - 0.5) * 30 : (R() - 0.5) * 120;
      const q = { name: `${p.name}${placed.length}` };
      if (p.opacity !== undefined) q.opacity = p.opacity;
      if (p.clip) q.clip = p.clip;
      if (p.sticker !== undefined) q.sticker = p.sticker;
      out.push(doodlePart(q, kind, x, y, kind === 'dot' ? s * 0.35 : s, rot, col, p.sw));
    }
    return out;
  }
  return [p];
}

export function renderChibi(doc) {
  const raw = expand({ ...doc, parts: applyFolds(doc.parts) });
  const shapes = new Map();
  for (const p of raw) if (p.type !== 'lace' && p.type !== 'band' && !shapes.has(p.name)) shapes.set(p.name, p);
  // 先展开 band（它本身可以被 lace 的 along 引用），再展开 lace
  const step1 = raw.flatMap(p => (p.type === 'band' ? expandBand(p, shapes) : [p]));
  for (const p of step1) if (p.type !== 'lace' && !shapes.has(p.name)) shapes.set(p.name, p);
  let parts = step1.flatMap(p => (p.type === 'lace' ? expandLace(p, shapes) : [p])).flatMap(p => expandDeco(p, doc, shapes));
  if (doc.view || doc.bodyView) parts = applyViews(doc, parts, shapeD, outlineOf);
  if (doc.pose) for (const p of parts) if (p.group && !doc.pose[p.group]) throw new Error(`group 指向 pose 里没有的组：${p.group}`);
  const byName = new Map();
  for (const p of parts) if (!byName.has(p.name)) byName.set(p.name, p);
  const defs = [], body = [];
  const vb = doc.viewBox || [-30, -60, 160, 200];
  const clips = new Set(), blurs = new Set(), masks = new Set();
  // brush：笔刷毛边。{ brush: 8 } 或 { brush: { scale, freq: [x, y], octaves, seed } }，把轮廓用噪声推歪成手涂的毛边
  for (const p of parts) {
    if (p.brush) {
      const b = typeof p.brush === 'object' ? p.brush : { scale: p.brush };
      p._brushId = `brush-${defs.length + 1}`;
      const [bx, by] = b.freq ? [].concat(b.freq, b.freq) : [0.03, 0.06];
      defs.push(`<filter id="${p._brushId}" filterUnits="userSpaceOnUse" x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}">`
        + `<feTurbulence type="fractalNoise" baseFrequency="${bx} ${by}" numOctaves="${b.octaves ?? 3}" seed="${b.seed ?? p.seed ?? 5}" result="n"/>`
        + `<feDisplacementMap in="SourceGraphic" in2="n" scale="${b.scale ?? 8}" xChannelSelector="R" yChannelSelector="G"${p.blur ? ' result="d"' : ''}/>`
        + (p.blur ? `<feGaussianBlur in="d" stdDeviation="${p.blur}"/>` : '') + '</filter>');
    }
  }
  for (const p of parts) {
    // clip 可以是一个部件名，也可以是几个部件名的数组（合在一起当遮罩，比如头 + 腮边毛）
    const ck = clipKey(p.clip);
    if (ck && !clips.has(ck)) {
      const names = Array.isArray(p.clip) ? p.clip : [p.clip];
      const els = names.map(nm => {
        const src = byName.get(nm);
        if (!src) throw new Error(`clip 指向不存在的部件：${nm}`);
        return src;
      });
      clips.add(ck);
      // 遮罩来源带笔刷毛边时改用 mask，毛边才会带进来
      if (els.some(src => src.brush)) {
        masks.add(ck);
        defs.push(`<mask id="clip-${clips.size}" data-of="${esc(ck)}" maskUnits="userSpaceOnUse" x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}">`
          + els.map(src => shapeEl(src, ` fill="#fff"${src.brush ? ` filter="url(#${src._brushId})"` : ''}`, doc.pose)).join('') + '</mask>');
      } else defs.push(`<clipPath id="clip-${clips.size}" data-of="${esc(ck)}">${els.map(src => shapeEl(src, '', doc.pose)).join('')}</clipPath>`);
    }
    if (p.blur && !p.brush && !blurs.has(p.blur)) {
      blurs.add(p.blur);
      defs.push(`<filter id="blur-${String(p.blur).replace('.', '_')}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${p.blur}"/></filter>`);
    }
  }
  const clipId = c => 'clip-' + ([...clips].indexOf(clipKey(c)) + 1);
  // 贴纸描边：doc.sticker = { width, color } 给角色整只描一圈（装饰部件不描，除非它自己写 sticker: true）。
  //   部件写 sticker: true / 数字（宽度）/ { width, color } 单独描；sticker: false 不描。挨着的、描法一样的部件合成一组描一圈外轮廓。
  const stk = doc.sticker ? { width: 2.4, color: '#ffffff', ...(typeof doc.sticker === 'object' ? doc.sticker : {}) } : null;
  const stickerOf = p => {
    if (p.sticker === false) return null;
    if (p.sticker) return { width: stk?.width ?? 2.4, color: stk?.color ?? '#ffffff', ...(typeof p.sticker === 'object' ? p.sticker : typeof p.sticker === 'number' ? { width: p.sticker } : {}) };
    return stk && !p._deco ? stk : null;
  };
  const stickerIds = new Map();
  const stKey = st => `${st.width}|${st.color}|${st.edge || ''}|${st.edgeWidth ?? ''}|${st.edgeStyle || ''}|${st.edgeOpacity ?? ''}`;
  const stickerId = st => {
    if (!stickerIds.has(stKey(st))) {
      const id = `sticker-${stickerIds.size + 1}`, w = st.width;
      stickerIds.set(stKey(st), id);
      // 胀开 → 模糊 → 阈值，拐角是圆的
      defs.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}">`
        + `<feMorphology in="SourceAlpha" operator="dilate" radius="${n(w * 0.7)}" result="d"/><feGaussianBlur in="d" stdDeviation="${n(w * 0.4)}" result="b"/>`
        + `<feComponentTransfer in="b" result="a"><feFuncA type="linear" slope="12" intercept="-4"/></feComponentTransfer>`
        + `<feFlood flood-color="${st.color}"/><feComposite in2="a" operator="in" result="o"/>`
        // edge：白边外面再晕一圈淡色（像贴纸边的阴影），白底上也看得见
        // edgeStyle "line"（默认）：白边再胀开 edgeWidth，是实的一圈细边；"glow"：从白边往外软软晕开，越往外越淡
        //   edgeOpacity 外圈的透明度（默认 1）
        + (st.edge ? (st.edgeStyle === 'glow'
          ? `<feMorphology in="a" operator="dilate" radius="${n((st.edgeWidth ?? w * 0.5) * 0.3)}" result="e0"/><feGaussianBlur in="e0" stdDeviation="${n((st.edgeWidth ?? w * 0.5) * 0.9)}" result="e1"/>`
          : `<feMorphology in="a" operator="dilate" radius="${n((st.edgeWidth ?? w * 0.5) * 0.7)}" result="e0"/><feGaussianBlur in="e0" stdDeviation="${n((st.edgeWidth ?? w * 0.5) * 0.35)}" result="e1"/>`)
          + `<feFlood flood-color="${st.edge}"${st.edgeOpacity != null && st.edgeOpacity !== 1 ? ` flood-opacity="${st.edgeOpacity}"` : ''}/><feComposite in2="e1" operator="in" result="e"/>` : '')
        + `<feMerge>${st.edge ? '<feMergeNode in="e"/>' : ''}<feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);
    }
    return stickerIds.get(stKey(st));
  };
  const clipAttr = c => `${masks.has(clipKey(c)) ? 'mask' : 'clip-path'}="url(#${clipId(c)})"`;
  for (const p of parts) {
    if (p.hidden) continue;
    let attrs = ` data-part="${esc(p.name)}"`;
    // 噪点花纹：feTurbulence 生成一片噪声，按阈值切成一块块斑，再用 clip 裁进身体里。不用一个个摆斑点。
    //   { type: "noise", fill: 斑的颜色, freq: 0.07（越小斑越大）, cover: 0.3（斑占多少，0–1）,
    //     soft: 0.08（边缘软硬，越小越硬）, octaves: 2（越大边越碎）, seed: 3（换一个数换一种分布）, opacity, clip }
    if (p.type === 'noise') {
      const id = `noise-${defs.length + 1}`, k = 1 / Math.max(0.01, p.soft ?? 0.08), t = 1 - (p.cover ?? 0.3) * 0.6 - 0.2;
      defs.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" color-interpolation-filters="sRGB">`
        + `<feTurbulence type="${p.turbulence ? 'turbulence' : 'fractalNoise'}" baseFrequency="${p.freq ?? 0.07}" numOctaves="${p.octaves ?? 2}" seed="${p.seed ?? 3}" result="t"/>`
        + `<feColorMatrix in="t" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${n(k)} 0 0 0 ${n(-t * k)}" result="a"/>`
        + `<feFlood flood-color="${p.fill || '#888'}"/><feComposite in2="a" operator="in"/></filter>`);
      const el = `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}"${attrs} filter="url(#${id})"${p.opacity !== undefined ? ` opacity="${p.opacity}"` : ''}/>`;
      body.push([p.clip ? `<g ${clipAttr(p.clip)}>${el}</g>` : el, stickerOf(p), p]);
      continue;
    }
    if (p.type === 'line' || (p.type === 'path' && !p.fill)) {
      attrs += ` fill="none" stroke="${p.stroke || '#555'}" stroke-width="${p.sw ?? 1.5}" stroke-linecap="round" stroke-linejoin="${p.join || 'round'}"`;
    } else {
      // fill 可以是颜色，也可以是线性渐变 { linear: [[x1,y1],[x2,y2]], stops: [颜色1, 颜色2, …] }，坐标和 pts 同一个坐标系
      if (p.fill && typeof p.fill === 'object') {
        const id = `grad-${defs.length + 1}`;
        const { radial, linear, stops } = p.fill;
        const tag = radial ? 'radialGradient' : 'linearGradient';
        let geometry;
        if (radial) {
          const [cx, cy, rx, ry] = radial;
          geometry = `cx="0" cy="0" r="1" gradientTransform="translate(${n(cx)} ${n(cy)}) scale(${n(rx)} ${n(ry)})"`;
        } else {
          const [[x1, y1], [x2, y2]] = linear;
          geometry = `x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"`;
        }
        const colors = stops.map((stop, i) => {
          const [color, offset, opacity = 1] = Array.isArray(stop) ? stop : [stop, i / Math.max(1, stops.length - 1)];
          return `<stop offset="${n(offset)}" stop-color="${esc(color)}" stop-opacity="${n(opacity)}"/>`;
        });
        defs.push(`<${tag} id="${id}" gradientUnits="userSpaceOnUse" ${geometry}>${colors.join('')}</${tag}>`);
        attrs += ` fill="url(#${id})"`;
      } else attrs += ` fill="${p.fill || '#ccc'}"`;
      if (p.stroke) attrs += ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}" stroke-linejoin="round"`;
    }
    if (p.opacity !== undefined) attrs += ` opacity="${p.opacity}"`;
    // 图层混合：腮红写 blend: "multiply"（正片叠底），颜色就跟着底下的皮肤走
    // （有 clip 时混合写在外面那层 <g> 上，写在里面会被遮罩组隔开、混不到皮肤上）
    // plus-darker（Figma 的 Plus darker，线性加深）：结果 = 底色 − (255 − 腮红色)，每种皮肤都压暗同样多。
    // 浏览器不认 plus-darker：底色就是 clip 指向的那块皮肤，直接算出「皮肤 − (255 − 腮红色)」填上，普通叠加。
    // 平涂的皮肤上和 Figma 结果一样，模糊的边缘也照常淡出（试过 difference 混合，Chrome 下模糊边会变硬）。
    let blend = p.blend;
    if (blend === 'plus-darker' && /^#[0-9a-f]{6}$/i.test(p.fill || '')) {
      // 遮罩部件是隐藏的、颜色不算数，那就用「头」
      let src = byName.get([].concat(p.clip || [])[0]);
      if (!src || src.hidden) src = byName.get('头');
      const base = src?.fill;
      if (/^#[0-9a-f]{6}$/i.test(base || '')) {
        const ch = (h, i) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
        const col = '#' + [0, 1, 2].map(i => Math.max(0, ch(base, i) + ch(p.fill, i) - 255).toString(16).padStart(2, '0')).join('');
        attrs = attrs.replace(/ fill="[^"]*"/, ` fill="${col}"`);
        blend = null;
      } else blend = 'multiply';   // 皮肤是渐变时退回正片叠底
    }
    const bl = blend ? ` style="mix-blend-mode:${blend}"` : '';
    if (bl && !p.clip) attrs += bl;
    if (p.brush) attrs += ` filter="url(#${p._brushId})"`;
    else if (p.blur) attrs += ` filter="url(#blur-${String(p.blur).replace('.', '_')})"`;
    const el = shapeEl(p, attrs, doc.pose);
    body.push([p.clip ? `<g ${clipAttr(p.clip)}${bl}>${el}</g>` : el, stickerOf(p), p]);
  }
  const bodyOut = [];
  for (let i = 0; i < body.length;) {
    const st = body[i][1];
    if (!st) { bodyOut.push([body[i][0], body[i][2]]); i++; continue; }
    const run = [];
    while (i < body.length && body[i][1] && stKey(body[i][1]) === stKey(st)) run.push(body[i++][0]);
    bodyOut.push([`<g filter="url(#${stickerId(st)})">\n${run.join('\n')}\n</g>`, null]);
  }
  // pastel：整只角色一起套的毛毡油画棒滤镜（若若 11-22 从海豹放纸船挑的那种）：
  //   边缘整体轻推一圈毛边 + 一层很淡的纸纹，不撒噪点。默认推 2、毛细 2（若若 11-24 在毛绒调节页定的）。
  //   顶层 pastel: true / { scale: 2（毛边推多远）, freq: [2, 1.516]（毛边多细，数越大越碎越细）, paper: 2.2（纸纹多细）, seed: 11 }。背景色不套。
  //   鼻子、眼睛、高光、眉、人中线、嘴线、胡须这些小件只推 fine（默认 1.1），比身体轻，不然 5 个单位宽的鼻子会被推歪。
  //   按图层顺序切成连续几段分别套滤镜，前后遮挡不变；噪声场在画布坐标里是同一片，各段毛边接得上。
  let charOut = bodyOut.map(b => b[0]).join('\n');
  if (doc.pastel) {
    const ps = { scale: 2, fine: 1.1, freq: [2, 1.516], paper: 2.2, seed: 11, ...(typeof doc.pastel === 'object' ? doc.pastel : {}) };
    const FINE = /眼|高光|眉|鼻子|人中|嘴线|嘴边弧线|胡须|睫毛|虹膜|舌/;
    const fine = p => !!p && (p.type === 'line' || (p.type === 'path' && !p.fill) || FINE.test(p.name));
    const pf = (id, scale) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" color-interpolation-filters="sRGB">`
      + `<feTurbulence type="fractalNoise" baseFrequency="${[].concat(ps.freq).join(' ')}" numOctaves="3" seed="${ps.seed}" result="fibres"/>`
      + `<feDisplacementMap in="SourceGraphic" in2="fibres" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="edges"/>`
      + `<feTurbulence type="fractalNoise" baseFrequency="${ps.paper}" numOctaves="2" seed="5"/><feColorMatrix type="saturate" values="0"/>`
      + `<feComponentTransfer><feFuncR type="linear" slope=".61" intercept=".20"/><feFuncG type="linear" slope=".61" intercept=".20"/><feFuncB type="linear" slope=".61" intercept=".20"/></feComponentTransfer>`
      + `<feBlend in2="edges" mode="soft-light"/><feComposite in2="edges" operator="in"/></filter>`;
    defs.push(pf('pastel', ps.scale), pf('pastel-fine', ps.fine));
    const runs = [];
    for (const [s, p] of bodyOut) {
      const k = fine(p) ? 'pastel-fine' : 'pastel';
      if (runs.length && runs.at(-1).k === k) runs.at(-1).s.push(s); else runs.push({ k, s: [s] });
    }
    charOut = runs.map(r => `<g filter="url(#${r.k})">\n${r.s.join('\n')}\n</g>`).join('\n');
  }
  const title = esc(doc.title || 'chibi');
  // 背景也可以写渐变：{ linear: [[x1,y1],[x2,y2]], stops: [...] }，坐标和部件同一个坐标系
  let bgFill = doc.background;
  if (bgFill && typeof bgFill === 'object') {
    const st = bgFill.stops, [[gx1, gy1], [gx2, gy2]] = bgFill.linear;
    defs.push(`<linearGradient id="grad-bg" gradientUnits="userSpaceOnUse" x1="${n(gx1)}" y1="${n(gy1)}" x2="${n(gx2)}" y2="${n(gy2)}">`
      + st.map((c, i) => { const [col, off] = Array.isArray(c) ? c : [c, st.length > 1 ? i / (st.length - 1) : 0]; return `<stop offset="${n(off)}" stop-color="${col}"/>`; }).join('') + '</linearGradient>');
    bgFill = 'url(#grad-bg)';
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${vb[2] * 3}" height="${vb[3] * 3}">\n<title>${title}</title>\n<defs>\n${defs.join('\n')}\n</defs>\n${doc.background ? `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="${bgFill}"/>\n` : ''}${charOut}\n</svg>\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), both = args.includes('--both'), pastelOnly = args.includes('--pastel');
  const [inp, outp] = args.filter(a => !a.startsWith('--'));
  if (!inp) { console.error('用法：node render.mjs <input.chibi.json> [output.svg] [--pastel | --both]'); process.exit(1); }
  const doc = JSON.parse(fs.readFileSync(inp, 'utf8'));
  const target = outp || inp.replace(/\.json$/, '') + '.svg';
  if (pastelOnly && !both) {
    // 正式交付：只出油画棒版，写到 target 本身
    fs.writeFileSync(target, renderChibi({ ...doc, pastel: doc.pastel || true }), 'utf8');
    console.log('wrote', target);
  } else if (both) {
    // 光滑版：去掉 pastel；油画棒版：整只套 pastel 毛毡滤镜（文件里写了 pastel 参数就用它）
    const { pastel: ps, ...plain } = doc;
    const pastel = { ...plain, pastel: ps || true };
    fs.writeFileSync(target, renderChibi(plain), 'utf8');
    const t2 = target.replace(/\.svg$/, '') + '.油画棒.svg';
    fs.writeFileSync(t2, renderChibi(pastel), 'utf8');
    console.log('wrote', target, t2);
  } else {
    fs.writeFileSync(target, renderChibi(doc), 'utf8');
    console.log('wrote', target);
  }
}
