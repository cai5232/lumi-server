#!/usr/bin/env node
// 拼装部件库：把 templates/部件库.json 里的一套部件，按「放法」挪到底稿上。零依赖。
//   node scripts/kit.mjs 底稿.chibi.json 输出.chibi.json 叶形耳=鹿 锥形小角=羊 条状尾=牛 鼻孔=猪
//   自己定位置：叶形耳=72.55,20.51,48,1   （部件根点挪到 x,y，绕根点转 rot 度，等比缩放 k）
//   能调长短的部件（长喙）：长喙=几维鸟,长0.6   （长 1 是最长，越小越短，只挪尖端，根部宽度不变；长 0 换成小鸟原版小嘴）
// 只做平移、等比缩放、旋转，形状不改；圆角半径和线宽跟着缩。
// 放法是在来源模板上量的，挂在一个参照部件上（耳朵、角挂头顶，尾巴挂身体底边，鼻孔挂口鼻中心）。
// 换到别的底稿时，跟着那只底稿的参照部件挪，并按参照部件的宽度等比缩放。
// 底稿里同名的部件（右耳、左耳……）先拿掉，再按部件库写的图层插回去。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expand } from './render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KITS = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', '部件库.json'), 'utf8')).kits;
const r2 = v => +v.toFixed(2);

// 一个点：p → at + k·R(rot)·(p − root)
function mover(root, { at, rot = 0, k = 1 }) {
  const a = rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return ([x, y]) => { const u = (x - root[0]) * k, v = (y - root[1]) * k; return [r2(at[0] + u * c - v * s), r2(at[1] + u * s + v * c)]; };
}
function movePart(p, f, k) {
  const q = structuredClone(p);
  if (q.pts) q.pts = q.pts.map(([x, y, r]) => (r === undefined ? f([x, y]) : [...f([x, y]), r2(r * k)]));
  if (q.r !== undefined) q.r = r2(q.r * k);
  if (q.sw !== undefined) q.sw = r2(q.sw * k);
  // path 只认绝对坐标的 M / L / C（部件库里的都是这种）
  if (q.d) q.d = q.d.replace(/(-?\d*\.?\d+)[ ,]+(-?\d*\.?\d+)/g, (_, x, y) => f([+x, +y]).join(' '));
  if (q.fill?.linear) q.fill.linear = q.fill.linear.map(f);
  return q;
}
// 镜像到另一边：名字和 clip 里的右/左对调，点序反转保持绕向
function mirrorPart(p, axis) {
  const q = structuredClone(p), swap = s => s.replace(/^右/, '\0').replace(/^左/, '右').replace('\0', '左');
  q.name = swap(p.name);
  if (typeof q.clip === 'string') q.clip = swap(q.clip);
  if (q.pts) q.pts = q.pts.map(([x, y, r]) => (r === undefined ? [r2(2 * axis - x), y] : [r2(2 * axis - x), y, r])).reverse();
  if (q.d) q.d = q.d.replace(/(-?\d*\.?\d+)[ ,]+(-?\d*\.?\d+)/g, (_, x, y) => `${r2(2 * axis - x)} ${y}`);
  if (q.fill?.linear) q.fill.linear = q.fill.linear.map(([x, y]) => [r2(2 * axis - x), y]);
  return q;
}

// 参照部件：头（头顶中点）、身体（底边中点）、口鼻（嘴努子2 / 猪鼻 / 嘴努子颜色的中心）
const CAP = /^(嘴努子2|猪鼻|嘴努子颜色)$/;
const ANCHOR = { 头: p => p.name === '头', 身体: p => p.name === '衣服主体' || p.name === '身体', 口鼻: p => CAP.test(p.name) };
export function anchorOf(doc, kind) {
  const parts = expand(doc), p = parts.find(p => p.name === '衣服主体' && kind === '身体') ?? parts.find(ANCHOR[kind]);
  if (!p?.pts) return null;
  const xs = p.pts.map(q => q[0]), ys = p.pts.map(q => q[1]), x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y = kind === '头' ? Math.min(...ys) : kind === '身体' ? Math.max(...ys) : (Math.min(...ys) + Math.max(...ys)) / 2;
  return { x: (x0 + x1) / 2, y, w: x1 - x0 };
}

// 放法可以是部件库里的名字（跟着 doc 的参照部件挪），也可以是 {at, rot, k}（直接写底稿坐标）
// 长短：把 tip 里那几个尖端点沿「根点→尖端」往回收，根部和圆角不动；长 0 用 tip.小嘴（原版小嘴）
function setLength(kit, parts, len) {
  if (len === undefined || len === 1) return parts;
  if (!kit.tip) throw new Error('这个部件不能调长短');
  if (len === 0 && kit.tip.小嘴) return [structuredClone(kit.tip.小嘴)];
  if (!(len >= kit.tip.最短 && len <= 1)) throw new Error(`长短要在 ${kit.tip.最短}–1 之间（1 最长）${kit.tip.小嘴 ? '，或写 0 用原版小嘴' : ''}`);
  const [rx, ry] = kit.root, q = structuredClone(parts);
  for (const i of kit.tip.点) { const p = q[0].pts[i]; p[0] = r2(rx + (p[0] - rx) * len); p[1] = r2(ry + (p[1] - ry) * len); }
  return q;
}

export function placeKit(name, how, doc = null) {
  const kit = KITS[name], axis = doc?.axis ?? 50;
  if (!kit) throw new Error(`部件库里没有「${name}」，有：${Object.keys(KITS).join('、')}`);
  let len;
  if (how && typeof how === 'object' && '放法' in how) ({ 长: len, 放法: how } = how);
  else if (how && typeof how === 'object') len = how.长;
  let t = typeof how === 'string' ? kit.放法[how] : how;
  if (!t) throw new Error(`「${name}」没有放法「${how}」，有：${Object.keys(kit.放法).join('、')}，或写 x,y,rot,k`);
  if (typeof how === 'string' && doc) {
    const a = kit.anchor[how] ?? kit.anchor._, b = anchorOf(doc, kit.anchorKind);
    if (!b) throw new Error(`底稿里没有「${kit.anchorKind}」，没法放「${name}」：改用 x,y,rot,k 直接写位置`);
    const s = b.w / a.w;
    t = { at: [r2(b.x + (t.at[0] - a.x) * s), r2(b.y + (t.at[1] - a.y) * s)], rot: t.rot ?? 0, k: (t.k ?? 1) * s };
  }
  const f = mover(kit.root, t), k = t.k ?? 1;
  const right = setLength(kit, kit.parts, len).map(p => movePart(p, f, k));
  return kit.mirror ? [...right, ...right.map(p => mirrorPart(p, axis))] : right;
}

function insertAt(parts, layer, add) {
  const at = {
    最后面: () => 0,
    头后面: () => parts.findIndex(p => p.name === '头'),
    // 底稿没有口鼻（或口鼻正被换掉）：放在脸上的阴影、腮红上面，再没有就紧跟头遮罩
    口鼻上: () => { const i = parts.findIndex(p => CAP.test(p.name)); if (i >= 0) return i + 1;
      const j = parts.findLastIndex(p => /面部阴影|腮红/.test(p.name)); return j >= 0 ? j + 1 : parts.findIndex(p => p.name === '头遮罩') + 1; },
    最前面: () => parts.length,
  }[layer];
  if (!at) throw new Error(`不认识的图层「${layer}」`);
  let i = at();
  if (i < 0) i = layer === '头后面' ? 0 : parts.length;
  return [...parts.slice(0, i), ...add, ...parts.slice(i)];
}

export function applyKits(doc, uses) {
  const out = structuredClone(doc), notes = [];
  for (const [name, how] of uses) {
    const kit = KITS[name], add = placeKit(name, how, doc), names = new Set(add.map(p => p.name));
    // 同名部件换掉；底稿里展开前的 mirror 原件也算（比如小猪的「右耳」带出「左耳」）
    out.parts = out.parts.filter(p => !names.has(p.name) && !(p.mirror && names.has(p.mirrorName)));
    // 一套部件可以分几层放（牛尾巴在身体后面、穗穗压在身体边上）
    for (const layer of [...new Set(add.map(p => kit.layers?.[p.name.replace(/^左/, '右')] ?? kit.layer))])
      out.parts = insertAt(out.parts, layer, add.filter(p => (kit.layers?.[p.name.replace(/^左/, '右')] ?? kit.layer) === layer));
    const label = typeof how === 'string' ? how + '的放法' : how.放法 ? how.放法 + '的放法' : '自定位置';
    notes.push(`${name}（${label}${how?.长 !== undefined ? '，长 ' + how.长 : ''}，借自${kit.from}）`);
  }
  // 借来的耳朵、尾巴可能伸出底稿的画框，画框跟着放大
  if (out.viewBox) {
    const pts = expand(out).flatMap(p => p.pts ?? (p.d?.match(/-?\d*\.?\d+[ ,]+-?\d*\.?\d+/g) ?? []).map(q => q.split(/[ ,]+/).map(Number)));
    const [x, y, w, h] = out.viewBox, xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
    const x0 = Math.min(x, Math.min(...xs) - 3), y0 = Math.min(y, Math.min(...ys) - 3);
    out.viewBox = [r2(x0), r2(y0), r2(Math.max(x + w, Math.max(...xs) + 3) - x0), r2(Math.max(y + h, Math.max(...ys) + 3) - y0)];
  }
  out.source = [doc.source, '拼装：' + notes.join('、')].filter(Boolean).join('；');
  return out;
}

function parseUse(arg) {
  const [name, all = ''] = arg.split('=');
  // 「,长0.6」可以接在放法名或坐标后面
  const m = all.match(/,长(-?\d*\.?\d+)$/), len = m ? +m[1] : undefined, how = m ? all.slice(0, m.index) : all;
  const nums = how.split(',').map(Number);
  if (how && nums.length >= 2 && nums.every(Number.isFinite)) return [name, { at: [nums[0], nums[1]], rot: nums[2] ?? 0, k: nums[3] ?? 1, 长: len }];
  const named = how || Object.keys(KITS[name]?.放法 ?? {})[0];
  return [name, len === undefined ? named : { 放法: named, 长: len }];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, dst, ...rest] = process.argv.slice(2);
  if (!src || !dst || !rest.length) {
    console.log('用法：node scripts/kit.mjs 底稿.chibi.json 输出.chibi.json 部件=放法 …');
    for (const [n, k] of Object.entries(KITS)) console.log(`  ${n}：放法 ${Object.keys(k.放法).join(' / ')}（${k.note}）`);
    process.exit(src ? 1 : 0);
  }
  const doc = applyKits(JSON.parse(fs.readFileSync(src, 'utf8')), rest.map(parseUse));
  fs.writeFileSync(dst, JSON.stringify(doc, null, 1) + '\n');
  console.log(`写出 ${dst}：${doc.source}`);
}
