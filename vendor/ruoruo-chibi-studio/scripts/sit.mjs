#!/usr/bin/env node
// 正面坐下：从站姿模板算出坐姿，只动腿和尾巴，身体、手、脸不动。
//   node scripts/sit.mjs templates/小狐狸1.chibi.json examples/小狐狸坐下.chibi.json
// 也可以 import { sitDown } from './sit.mjs' 在拼图脚本里用。
//
// 做法（若若 2026-11-22 定稿）：
//   腿：保留原腿的顶点、宽度和圆角，以脚底为基准把高度压到 0.75，再整条往上挪 3，
//       图层从身体后面挪到「身体」后面一层（手仍在最前），变成压在下摆上的膝盖。
//   尾巴：往下垂的尾巴绕尾根（藏在身体里的那几个点的中点）向上转 30°，
//       在画面左边的顺时针转，在右边的逆时针转。尾巴原本就翘着或是圆球尾，不转。
//       转完尾巴最低点还比脚底低，就把整条尾巴竖直往上提到和脚底平齐（若若 11-24 选的：角度和弯不变，
//       尾根往身体里多藏一点；多转到 48° 会糊成一团、缩小尾巴会变小毛球，都不要）。
// 输出文件带 action 字段，check.mjs 会拿它和原模板对比：腿变短、腿在身体前、尾巴绕尾根转过（再提 tailUp）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIT = { legScale: 0.75, legUp: 3, tailTurn: 30 };

const isLeg = p => /^(左腿|右腿|腿左|腿右)$/.test(p.name);
const round = v => +v.toFixed(2);

function inside([x, y], poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// 尾根：藏在身体里、靠近身体中线的那一簇点的中点（尾巴别处偶尔也有点压进身体，不算）。
// 没有点落在身体里就没有尾根，不转。
export function tailRoot(tail, body, axis = 50) {
  const inBody = tail.pts.filter(q => inside(q, body.pts));
  if (!inBody.length) return null;
  const near = inBody.reduce((a, q) => (Math.abs(q[0] - axis) < Math.abs(a[0] - axis) ? q : a));
  const hid = inBody.filter(q => Math.hypot(q[0] - near[0], q[1] - near[1]) < 6);
  return [hid.reduce((a, q) => a + q[0], 0) / hid.length, hid.reduce((a, q) => a + q[1], 0) / hid.length];
}

// 尾巴转多少度（带方向）；不该转的返回 0
export function tailAngle(tail, body, root, turn = SIT.tailTurn) {
  if (!tail?.pts || tail.pts.length <= 4 || !root) return 0;          // 圆球尾不转
  const cx = tail.pts.reduce((a, q) => a + q[0], 0) / tail.pts.length;
  const cy = tail.pts.reduce((a, q) => a + q[1], 0) / tail.pts.length;
  if (cy < root[1]) return 0;                                         // 本来就翘着
  return cx < root[0] ? turn : -turn;
}

export function sitDown(template, opt = {}) {
  const { legScale, legUp, tailTurn } = { ...SIT, ...opt };
  const doc = structuredClone(template);
  const body = doc.parts.find(p => p.name === '身体');
  if (!body?.pts) throw Error('坐下需要模板里有 poly 的「身体」');
  const legs = doc.parts.filter(isLeg);
  if (!legs.length) throw Error('坐下需要模板里有「左腿」「右腿」');
  for (const leg of legs) {
    if (leg.mirror) throw Error(`${leg.name} 用了 mirror，先拆成左右两条再坐`);
    const bottom = Math.max(...leg.pts.map(q => q[1]));
    leg.pts = leg.pts.map(([x, y, ...r]) => [x, round(bottom - (bottom - y) * legScale - legUp), ...r]);
  }
  doc.parts = doc.parts.filter(p => !legs.includes(p));
  doc.parts.splice(doc.parts.findIndex(p => p === body) + 1, 0, ...legs);

  const tail = doc.parts.find(p => p.name === '尾巴');
  const root = tail?.pts ? tailRoot(tail, body, doc.axis ?? 50) : null;
  const deg = tail ? tailAngle(tail, body, root, tailTurn) : 0;
  if (deg) {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    tail.pts = tail.pts.map(([x, y, ...r]) => {
      const dx = x - root[0], dy = y - root[1];
      return [round(root[0] + dx * c - dy * s), round(root[1] + dx * s + dy * c), ...r];
    });
  }
  // 尾巴不能比脚低：转完还低就整条往上提
  let up = 0;
  if (tail?.pts) {
    const foot = Math.max(...legs.flatMap(l => l.pts.map(q => q[1])));
    up = round(Math.max(0, Math.max(...tail.pts.map(q => q[1])) - foot));
    if (up) tail.pts = tail.pts.map(([x, y, ...r]) => [x, round(y - up), ...r]);
  }
  doc.title = `${template.title || '角色'}·坐下`;
  doc.action = { type: '坐下', legScale, legUp, tailTurn: deg, ...(root && deg ? { tailRoot: root.map(round) } : {}), ...(up ? { tailUp: up } : {}) };
  return doc;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) { console.error('用法：node scripts/sit.mjs <站姿模板.chibi.json> <输出.chibi.json>'); process.exit(2); }
  const tpl = JSON.parse(fs.readFileSync(src, 'utf8'));
  const doc = sitDown(tpl);
  doc.action.from = path.basename(src).replace(/\.chibi\.json$/, '');
  fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n');
  console.log(`${out}：腿高 ×${doc.action.legScale}、上移 ${doc.action.legUp}，尾巴转 ${doc.action.tailTurn}°${doc.action.tailUp ? `、上提 ${doc.action.tailUp}` : ''}`);
}
