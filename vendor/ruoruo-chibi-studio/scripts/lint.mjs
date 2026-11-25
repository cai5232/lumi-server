#!/usr/bin/env node
// 按若若的画法检查一只小动物。零依赖。
//   node scripts/lint.mjs 角色.chibi.json      检查 A 方式的源文件（推荐，查得最全）
//   node scripts/lint.mjs 角色.svg             检查 B 方式直接写的 SVG
// ERROR = 违反风格底线；WARN = 多半不对，看一眼。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const TPL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

const file = process.argv[2];
if (!file) { console.error('usage: lint.mjs 角色.chibi.json | 角色.svg'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8');
const text = file.endsWith('.svg') ? raw.replace(/<!--[\s\S]*?-->/g, '') : raw; // 注释里的字不算
const errors = [], warns = [];
const E = m => errors.push(m), W = m => warns.push(m);

const FACE = /眼|眉|鼻|嘴|努子|腮红|面部阴影|舌/;
// 要裁进头里的五官：胡须、手、耳朵、眼镜眼罩这类配件不算
const isFacePart = nm => FACE.test(nm) && !/须|手|耳|眼镜|眼罩|墨镜/.test(nm);
// 五官要和来源模板逐点一致（若若 11-22：五官最能看出画风，现场重画会走样）。
// 只比形状：整体平移（转脸滑动）不算改，颜色可以换；故意换表情的部件写 "expr": true（B 方式 data-expr）跳过。
// 比的是这只动物自己的模板（templates/<from>），不是五官样板「模板」：动物模板里有更新的五官。
const FACE_SHAPE = nm => isFacePart(nm) && !/腮红|面部阴影/.test(nm);
const numsOf = d => (d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
const cmdsOf = d => (d || '').replace(/[-\d.e\s,]+/gi, '');
const shift = v => { const x0 = v[0] ?? 0, y0 = v[1] ?? 0; return v.map((t, i) => t - (i % 2 ? y0 : x0)); };
const close = (a, b, tol = 0.05) => a.length === b.length && a.every((t, i) => Math.abs(t - b[i]) <= tol);
function shapeDiff(a, b) {           // 两个 chibi 部件形状一样返回 null，不一样返回原因
  if ((a.type || 'poly') !== (b.type || 'poly')) return `类型从 ${b.type || 'poly'} 变成 ${a.type || 'poly'}`;
  if (a.type === 'ellipse' || a.type === 'star') {
    for (const k of ['rx', 'ry', 'rotate', 'points', 'inner']) if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 0.05) return `${k} 从 ${b[k] ?? 0} 变成 ${a[k] ?? 0}`;
    return null;
  }
  if (a.d !== undefined || b.d !== undefined)
    return cmdsOf(a.d) === cmdsOf(b.d) && close(shift(numsOf(a.d || '')), shift(numsOf(b.d || ''))) ? null : '路径改了';
  if (!a.pts || !b.pts) return null;
  if (a.pts.length !== b.pts.length) return `点数从 ${b.pts.length} 变成 ${a.pts.length}`;
  if (!close(shift(a.pts.flatMap(q => q.slice(0, 2))), shift(b.pts.flatMap(q => q.slice(0, 2))))) return '点位改了';
  const rr = p => p.pts.map(q => q[2] ?? p.r ?? 0);
  if (!close(rr(a), rr(b), 0.5)) return '圆角改了';
  if (Math.abs((a.smooth ?? 0) - (b.smooth ?? 0)) > 0.01) return `smooth 从 ${b.smooth ?? 0} 变成 ${a.smooth ?? 0}`;
  if (a.sw !== undefined && b.sw !== undefined && Math.abs(a.sw - b.sw) > 0.05) return `线宽从 ${b.sw} 变成 ${a.sw}`;
  return null;
}
function loadTemplate(from, ext) {
  const f = path.join(TPL, `${from}${ext}`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
const isLine = p => p.type === 'line' || (p.type === 'path' && !p.fill);
const hex = c => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);
const gray = c => { const n = parseInt(c.slice(1), 16); return ((n >> 16 & 255) + (n >> 8 & 255) + (n & 255)) / 3; };

if (file.endsWith('.json')) {
  const doc = JSON.parse(text);
  if (doc.schema !== 'ruoruo-chibi@0.1') E(`schema 应该是 ruoruo-chibi@0.1，现在是 ${doc.schema}`);
  // 字段写错字：顶层直接 ERROR（写错了渲染器不报错，只是悄悄不起作用）；部件里先 WARN。字段表来自 schema。
  const SCHEMA = JSON.parse(fs.readFileSync(path.join(TPL, '..', 'schema', 'ruoruo-chibi.schema.json'), 'utf8'));
  const TOP = Object.keys(SCHEMA.properties), PART = Object.keys(SCHEMA.$defs.part.properties);
  const guess = (k, list) => {
    const lev = (a, b) => {   // 编辑距离，两个字母写反（veiw）算一步
      const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
      return d[a.length][b.length]; };
    const best = list.map(c => [c, c.toLowerCase() === k.toLowerCase() ? 0 : lev(k, c)]).sort((a, b) => a[1] - b[1])[0];
    return best && best[1] <= Math.max(1, Math.floor(k.length / 3)) ? `，是不是想写 ${best[0]}？` : '';
  };
  // 11-24 若若定只用一种画法：fuzz / crayon / grain 已从渲染器删掉，只留 pastel
  const RETIRED = new Set(['fuzz', 'crayon', 'grain']);
  for (const k of Object.keys(doc)) if (!TOP.includes(k)) E(RETIRED.has(k) ? `顶层字段 ${k} 已停用（只用一种画法），删掉它，成品用 --pastel 出油画棒版` : `顶层字段 ${k} 渲染器不认识，写了也不起作用${guess(k, TOP)}`);
  for (const p of doc.parts || []) for (const k of Object.keys(p))
    if (RETIRED.has(k)) W(`「${p.name}」的字段 ${k} 已停用（只用一种画法），删掉它`);
    else if (!PART.includes(k)) W(`「${p.name}」的字段 ${k} 渲染器不认识，写了也不起作用${guess(k, PART)}`);
  const parts = doc.parts || [];
  const names = new Set(parts.map(p => p.name));
  for (const p of parts) if (p.mirror && p.mirrorName) names.add(p.mirrorName);
  for (const p of parts) if (p.type === 'flap') names.add(p.name);
  const head = parts.find(p => p.name === '头');
  if (!head) W('没有叫「头」的部件：脸部遮罩、默认比例都以它为准');

  for (const p of parts) {
    const where = `「${p.name}」`;
    // 不描边：有填充的形状不许再加 stroke
    if (p.stroke && p.fill && !isLine(p)) E(`${where} 既有 fill 又有 stroke：若若的画法不描边，靠色块分开部件`);
    // 不缩放
    if (p.scale !== undefined || /scale\(/.test(JSON.stringify(p))) E(`${where} 用了 scale：改形状靠拉点，缩放会让圆角一起变形`);
    // 遮罩指向
    for (const c of [].concat(p.clip || [])) if (!names.has(c)) E(`${where} 的 clip 指向不存在的部件「${c}」`);
    if (p.type === 'flap' && !parts.some(q => q.name === p.of && q.fold)) E(`${where} 的 of 要指向一个带 fold 的部件`);
    // 五官要用头做遮罩
    // 腮红要模糊
    if (/腮红|面部阴影/.test(p.name) && !p.blur && !isLine(p)) W(`${where} 没有 blur：面部阴影是模糊色块（W=100 时约 3.8）`);
    if (/腮红|面部阴影/.test(p.name) && p.blur && (p.blur < 1.5 || p.blur > 6)) W(`${where} blur ${p.blur} 偏离 3.8 太多`);
    // 线性加深的腮红：色号只许比 #FDEFEF 更灰（S ≤ 5.5%）、更亮（B ≥ 99%），色相随意
    if (/腮红|面部阴影/.test(p.name) && p.blend === 'plus-darker' && hex(p.fill)) {
      const v = [1, 3, 5].map(i => parseInt(p.fill.slice(i, i + 2), 16)), mx = Math.max(...v), mn = Math.min(...v);
      const S = mx ? (mx - mn) / mx * 100 : 0, B = mx / 255 * 100;
      // 底下的皮肤：clip 指向的部件（隐藏的遮罩不算，用头）；渐变取最浅的那个色
      let src = parts.find(q => q.name === [].concat(p.clip || [])[0]);
      if (!src || src.hidden) src = head;
      const cols = typeof src?.fill === 'object' ? src.fill.stops.map(c => [].concat(c)[0]) : [src?.fill];
      const hsb = c => { const v = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)), mx = Math.max(...v), mn = Math.min(...v); return [mx ? (mx - mn) / mx * 100 : 0, mx / 255 * 100]; };
      const white = cols.some(c => hex(c) && hsb(c)[0] <= 8 && hsb(c)[1] >= 95);
      const [maxS, minB] = white ? [18, 96] : [5.6, 99];
      if (S > maxS || B < minB) W(`${where} 色号 ${p.fill}（S ${S.toFixed(1)}%、B ${B.toFixed(1)}%）：腮红只能比 #FDEFEF 更灰、更亮（S ≤ 5.5%、B ≥ 99%；白皮肤放宽到 S ≤ 18%、B ≥ 96%），色相可以改`);
    }
    // 纯黑
    for (const c of [p.fill, p.stroke]) if (hex(c) === '#000000') W(`${where} 用了纯黑：深色用带一点色相的深灰（如 #2f2a33）`);
    // 脸上的深色件（眼睛、鼻子、嘴、胡须）是纯灰：要带一点色相（头不是灰色时才查，灰猫灰兔不算）
    const sat = c => { const v = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)); return Math.max(...v) - Math.min(...v); };
    const headHex = hex(head?.fill);
    if (headHex && sat(headHex) > 20) for (const c of [p.fill, p.stroke]) {
      if (hex(c) && sat(c) <= 6 && gray(c) < 200 && (p.clip || /须|Line/.test(p.name) || isLine(p)) && !/耳机|眼镜|罩|带/.test(p.name))
        W(`${where} 用了纯灰 ${c}：眼睛、鼻嘴、胡须按脸色和虹膜色带一点色相（暖脸偏红棕、冷脸偏蓝紫），胡须和脸同色系`);
    }
    // 圆角：多边形全部尖角就不像她的画法
    if (p.pts && !isLine(p) && p.type !== 'line' && !p.blur) {
      const allSharp = (p.r ?? 0) === 0 && p.pts.every(q => !q[2]);
      if (allSharp && !/衣|裙|领|帽|带|纹|鳞/.test(p.name)) W(`${where} 所有角都是尖的：除了衣服、花纹，形状都该是圆角多边形`);
    }
  }

  // 五官要用头做遮罩：没写 clip、或者 clip 到了头以外的部件，转脸时就会飞出头外（若若 11-22：小狗3 眉毛、蛇蛇眼睛）
  // 胡须不进蒙版（压进去很怪），线条、手、耳朵、眼镜这类配件也不算五官
  if (head) {
    const byName = new Map(parts.map(p => [p.name, p]));
    const headish = nm => /头|腮边毛|脸/.test(nm) || /头|腮边毛|脸/.test([].concat(byName.get(nm)?.clip || []).join());
    for (const p of parts) {
      if (!isFacePart(p.name) || p.hidden) continue;
      const clip = [].concat(p.clip || []);
      if (!clip.length) E(`「${p.name}」没有 clip：五官、腮红要用头（和腮边毛）做遮罩，写 "clip": "${byName.has('头遮罩') ? '头遮罩' : '头'}"，不然转脸时会飞出头外`);
      else if (!clip.some(headish)) E(`「${p.name}」clip 到了「${clip.join('+')}」：五官要裁进头（和腮边毛）里`);
    }
  }

  // 五官要在头的下半部分（以头的包围盒为准；头身一体的换底座物种不查）
  if (head && head.pts && Math.max(...head.pts.map(q => q[1])) - Math.min(...head.pts.map(q => q[1])) < 90) {
    const ys = head.pts.map(q => q[1]), top = Math.min(...ys), bot = Math.max(...ys), mid = (top + bot) / 2;
    for (const p of parts) {
      if (!/^(右|左)?眼$/.test(p.name)) continue;
      const cy = p.pts ? (Math.min(...p.pts.map(q => q[1])) + Math.max(...p.pts.map(q => q[1]))) / 2 : p.cy;
      if (cy !== undefined && cy < mid) W(`「${p.name}」中心 y=${cy.toFixed(1)} 在头高一半以上（头 ${top.toFixed(0)}–${bot.toFixed(0)}）：五官都在头的下半部分`);
    }
  }

  // 五官和来源模板逐点比（写了 from，或者动作脚本写的 action.from）
  const from = doc.from ?? doc.action?.from;
  if (from !== undefined) {
    const src = loadTemplate(from, '.chibi.json');
    if (!src) E(`from 写的是「${from}」，但 templates/${from}.chibi.json 不存在`);
    else {
      const tplParts = JSON.parse(src).parts, T = new Map(tplParts.map(p => [p.name, p]));
      for (const p of parts) {
        if (!FACE_SHAPE(p.name) || p.expr || !T.has(p.name)) continue;
        const why = shapeDiff(p, T.get(p.name));
        if (why) E(`「${p.name}」和模板「${from}」不一样（${why}）：五官照模板原样用，只许整体平移；故意换的表情写 "expr": true`);
      }
      const have = new Set(parts.flatMap(p => [p.name, p.mirrorName]));
      const gone = tplParts.flatMap(p => [p.name, p.mirrorName]).filter(nm => nm && FACE_SHAPE(nm) && !have.has(nm));
      if (gone.length && !parts.some(p => p.expr)) W(`模板「${from}」的五官少了 ${gone.slice(0, 4).join('、')}：是故意去掉的吗`);
    }
  }

  // 眉毛和头要拉开明暗
  const headFill = hex(head?.fill);
  for (const p of parts) if (/眉/.test(p.name) && headFill && hex(p.fill)) {
    const d = Math.abs(gray(p.fill) - gray(headFill));
    if (d < 25) W(`「${p.name}」和头的明暗只差 ${d.toFixed(0)}：眉毛要和头色拉开（浅头深眉、深头浅眉）`);
  }

  // 深色皮毛不能和眼睛的深色一个明度（L 是 CIE 明度 0–100）
  const Lab = c => { const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const n = parseInt(c.slice(1), 16), Y = 0.2126 * f(n >> 16 & 255) + 0.7152 * f(n >> 8 & 255) + 0.0722 * f(n & 255);
    return 116 * Math.cbrt(Y) - 16; };
  const eyeL = Math.min(...parts.filter(p => p.clip && hex(p.fill) && !isLine(p)).map(p => Lab(p.fill)));
  if (headFill && isFinite(eyeL) && Lab(headFill) - eyeL < 8)
    W(`头色 ${headFill}（明度 ${Lab(headFill).toFixed(0)}）和眼睛最深色（明度 ${eyeL.toFixed(0)}）太近：深色皮毛要比眼睛亮一截（约 38–45），或者把眼睛压得更深`);

  // 动作图里尾巴不能比脚低（若若 11-24：狐狸、猫、狗、狼、鼠、松鼠的模板尾巴站姿就垂到脚下面，画动作必须绕尾根转上去）
  // 只查摆了动作的文件（写了 pose / view / bodyView / action），模板本身是站姿原稿不查。按部件 rotate 和 pose 组算出画面上的位置再比。
  if (doc.pose || doc.view || doc.bodyView || doc.action) {
    const rot = (q, deg, cx = 0, cy = 0) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      return [cx + (q[0] - cx) * c - (q[1] - cy) * s, cy + (q[0] - cx) * s + (q[1] - cy) * c]; };
    const place = (p, q) => {
      if (p.rotate) q = rot(q, p.rotate, p.cx, p.cy);
      for (let g = doc.pose?.[p.group], seen = 0; g && seen < 20; g = doc.pose?.[g.parent], seen++) {
        if (g.rotate) q = rot(q, g.rotate, g.cx, g.cy);
        q = [q[0] + (g.dx ?? 0), q[1] + (g.dy ?? 0)];
      }
      return q;
    };
    const ptsOf = p => p.pts ? p.pts.map(q => q.slice(0, 2)) : p.d ? numsOf(p.d).reduce((a, v, i, all) => (i % 2 ? a : a.concat([[v, all[i + 1]]])), []) : [];
    const lowest = re => { let y = -Infinity; for (const p of parts) if (re.test(p.name) && !p.hidden) for (const q of ptsOf(p)) y = Math.max(y, place(p, q)[1]); return y; };
    const tailY = lowest(/^尾巴(?!遮罩)/), footY = lowest(/腿|脚/);
    if (isFinite(tailY) && isFinite(footY) && tailY > footY + 1)
      W(`尾巴最低点 y=${tailY.toFixed(1)} 比脚底 y=${footY.toFixed(1)} 还低：画动作时尾巴要绕尾根（藏在身体里那端）往上转，别让尾尖拖到脚下面`);
  }

  // 相邻同色：前后挨着、又不是同一种部件的两块颜色一样，会糊成一块（左右成对、编号的一组不算）
  const stem = nm => nm.replace(/^[右左]|[右左]|_?\d+$/g, '').replace(/(上|下|外|内)$/, '');
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i - 1], b = parts[i];
    if (a.clip || b.clip || isLine(a) || isLine(b) || a.hidden || b.hidden || stem(a.name) === stem(b.name)) continue;
    if (/手/.test(a.name) && /手/.test(b.name)) continue;
    if (hex(a.fill) && hex(a.fill) === hex(b.fill) && !/腮边毛|尾|鳍/.test(a.name + b.name) && a.mirrorName !== b.name)
      W(`「${a.name}」和「${b.name}」前后挨着、颜色一样（${a.fill}）：同一部位的前后层差一档明暗`);
  }
} else {
  // B 方式：只能查 SVG 层面的事
  if (!/<svg[^>]*viewBox=/.test(text)) E('根 <svg> 要有 viewBox');
  // A uniform scale can place a complete character or prop group on the canvas.
  for (const tag of text.matchAll(/<([\w:-]+)\b([^<>]*)>/g)) {
    const attrs = tag[2];
    const transform = attrs.match(/\stransform\s*=\s*(["'])(.*?)\1/s)?.[2] || '';
    for (const scale of transform.matchAll(/\bscale\s*\(([^)]*)\)/g)) {
      const factors = scale[1].trim().split(/[\s,]+/).map(Number);
      const uniform = factors.length === 1 || (factors.length === 2 && factors[0] === factors[1]);
      if (tag[1] !== 'g' || /\sdata-part\s*=/.test(attrs) || !uniform || !(factors[0] > 0))
        E('scale() 仅用于整组等比布局；改变部件轮廓请调整顶点');
    }
  }
  for (const m of text.matchAll(/<(path|ellipse|circle|rect|polygon)\b([^>]*)>/g)) {
    const a = m[2];
    const fill = a.match(/\sfill="([^"]+)"/)?.[1], stroke = a.match(/\sstroke="([^"]+)"/)?.[1];
    if (stroke && stroke !== 'none' && fill && fill !== 'none') E(`有填充的形状加了描边：${m[0].slice(0, 80)}…`);
  }
  const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  for (const m of text.matchAll(/url\(#([^)]+)\)/g)) if (!ids.includes(m[1])) E(`url(#${m[1]}) 指向不存在的 id`);
  if (!/clip-path=|mask=/.test(text)) W('没有任何 clip-path：五官、腮红、拼色都要用遮罩');

  // id 不能重复：同一只狐狸复制两份进一张图，clip-1 会撞车，第二只的五官裁进第一只的头
  //   遮罩 id 撞车是 ERROR；模糊滤镜这类内容一样的定义撞车只提醒（浏览器取第一个，画出来一样）
  const dupIds = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  const defsOf = new Map();          // id → 这个 id 每次出现时整段定义的内容（去掉 id）
  for (const m of text.matchAll(/<(\w+)\b[^>]*\sid="([^"]+)"[^>]*?(\/>|>[\s\S]*?<\/\1>)/g))
    (defsOf.get(m[2]) || defsOf.set(m[2], []).get(m[2])).push({ tag: m[1], body: m[0].replace(/\sid="[^"]*"/, '') });
  const dupClip = dupIds.filter(id => defsOf.get(id)?.some(d => /^(clipPath|mask)$/.test(d.tag)) || new Set(defsOf.get(id)?.map(d => d.body)).size > 1);
  const dupSame = dupIds.filter(id => !dupClip.includes(id));
  if (dupClip.length) E(`id 重复（${dupClip.slice(0, 4).join('、')}${dupClip.length > 4 ? '…' : ''}）：一张图放两只角色时，每只的 id 加前缀（如 a-clip-1、b-clip-1），不然后一只会用前一只的遮罩`);
  if (dupSame.length) W(`id 重复（${dupSame.slice(0, 4).join('、')}${dupSame.length > 4 ? '…' : ''}）：内容一样暂时不影响画面，最好也加前缀`);

  // 五官要裁进自己的头：沿着标签往上找 clip-path / mask（父组上的也算），
  // 遮罩要是头（data-of 或 id 里有 头/head/face），而且得是同一只角色里定义的。
  // 一只角色 = 带 data-character 的 <g>，或者嵌套的 <svg>。
  const defs = new Map();            // id → { of, scope }
  const uses = [];                    // { name, refs: [id], scope }
  const stack = [];
  const scopeOf = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].scope) return stack[i].scope; return 'root'; };
  let scopeN = 0;
  for (const m of text.matchAll(/<(\/?)([\w:-]+)\b([^<>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, self] = m;
    if (tag.startsWith('!') || tag.startsWith('?')) continue;
    if (close) { while (stack.length && stack.pop().tag !== tag); continue; }
    const attr = k => attrs.match(new RegExp(`\\s${k}\\s*=\\s*"([^"]*)"`))?.[1];
    const inDef = stack.some(s => /^(clipPath|mask|defs|pattern|symbol)$/.test(s.tag));
    const nested = tag === 'svg' && stack.some(s => s.tag === 'svg');
    const node = { tag, scope: (attr('data-character') !== undefined || nested) ? `角色${++scopeN}` : null,
      refs: [attr('clip-path'), attr('mask')].map(v => v?.match(/url\(#([^)]+)\)/)?.[1]).filter(Boolean) };
    const id = attr('id');
    if (id && /^(clipPath|mask)$/.test(tag)) defs.set(id, { of: attr('data-of') || '', scope: scopeOf() });
    const part = attr('data-part');
    if (part && !inDef && isFacePart(part))
      uses.push({ name: part, refs: [...stack.flatMap(s => s.refs), ...node.refs], scope: node.scope || scopeOf() });
    if (!self) stack.push(node);
  }
  const headClip = id => /头|腮边毛|脸|head|face/i.test(defs.get(id)?.of + id);
  const bad = { none: new Set(), other: new Set(), cross: new Set() };
  // 没有头的文件（五官样板、衣柜单件）不查
  if (!/data-part="头(遮罩)?"/.test(text)) uses.length = 0;
  for (const u of uses) {
    const known = u.refs.filter(r => defs.has(r));
    if (!known.length) { bad.none.add(u.name); continue; }
    if (!known.some(headClip)) { bad.other.add(u.name); continue; }
    if (known.filter(headClip).every(r => defs.get(r).scope !== 'root' && defs.get(r).scope !== u.scope)) bad.cross.add(u.name);
  }
  const list = s => [...s].slice(0, 5).join('、') + (s.size > 5 ? '…' : '');
  if (bad.none.size) E(`五官没裁进头里（${list(bad.none)}）：给它或它所在的组加 clip-path="url(#头遮罩的 id)"，不然转脸时会飞出头外`);
  if (bad.other.size) W(`五官的遮罩看不出是不是头（${list(bad.other)}）：头遮罩的 clipPath 写 data-of="头" 或 id 里带 head`);
  if (bad.cross.size) E(`五官裁进了另一只角色的头（${list(bad.cross)}）：每只角色用自己 <g data-character> 里定义的头遮罩`);
  if (!/feGaussianBlur/.test(text)) W('没有模糊滤镜：腮红是 feGaussianBlur 的柔和色块');
  // 五官和来源模板逐点比：角色外层（<g data-character> 或嵌套 <svg>）写 data-from="小狐狸1"
  for (const m of text.matchAll(/<(g|svg)\b[^>]*\sdata-from="([^"]+)"[^>]*>/g)) {
    const from = m[2], tplSvg = loadTemplate(from, '.svg');
    if (!tplSvg) { E(`data-from 写的是「${from}」，但 templates/${from}.svg 不存在`); continue; }
    // 找到这一层的结束标签
    let depth = 0, end = text.length;
    for (const t of text.slice(m.index).matchAll(/<(\/?)(g|svg)\b[^>]*?(\/?)>/g)) {
      if (t[3]) continue;
      depth += t[1] ? -1 : 1;
      if (!depth) { end = m.index + t.index; break; }
    }
    const shapesIn = src => {
      const out = new Map();
      for (const e of src.matchAll(/<(path|ellipse)\b([^>]*)>/g)) {
        const get = k => e[2].match(new RegExp(`\\s${k}="([^"]*)"`))?.[1];
        const nm = get('data-part');
        if (!nm || !FACE_SHAPE(nm) || out.has(nm)) continue;
        out.set(nm, { expr: get('data-expr') !== undefined, v: e[1] === 'ellipse' ? ['E', +get('rx'), +get('ry')] : get('d') || '' });
      }
      return out;
    };
    const mine = shapesIn(text.slice(m.index, end)), T = shapesIn(tplSvg);
    const bad = [];
    for (const [nm, x] of mine) {
      if (x.expr || !T.has(nm)) continue;
      const t = T.get(nm).v;
      const same = Array.isArray(x.v) ? Array.isArray(t) && close(x.v.slice(1), t.slice(1))
        : typeof t === 'string' && cmdsOf(x.v) === cmdsOf(t) && close(shift(numsOf(x.v)), shift(numsOf(t)), 0.06);
      if (!same) bad.push(nm);
    }
    if (bad.length) E(`「${from}」的五官和模板不一样（${bad.slice(0, 5).join('、')}${bad.length > 5 ? '…' : ''}）：照模板 SVG 原样复制 path，转脸用外层 <g transform> 挪；故意换的表情写 data-expr`);
    // 和 A 方式一样：模板有、这里没有的五官（最常漏的是整块嘴努子）要提醒
    const gone = [...T.keys()].filter(nm => !mine.has(nm));
    if (gone.length && ![...mine.values()].some(x => x.expr))
      W(`「${from}」的五官少了 ${gone.slice(0, 4).join('、')}${gone.length > 4 ? '…' : ''}：是故意去掉的吗（嘴努子最容易漏）`);
  }
  if (/#000000|#000\b|"black"/i.test(text)) W('用了纯黑：深色用带一点色相的深灰');

  // 正式滤镜（若若的试用机 11-24 反馈）：B 路线手抄 pastel 漏了最后的 feComposite in，
  // XML 合法、Chrome 看着也还行，Safari 却把整个滤镜区域画成灰色方块，文件还被叫成了油画棒版。
  const filters = [...text.matchAll(/<filter\b([^>]*)>([\s\S]*?)<\/filter>/g)].map(m => ({ id: m[1].match(/\sid="([^"]+)"/)?.[1] || '', body: m[2] }));
  // 1. 带噪声的滤镜，最后一步必须把结果收回形状里，不然透明处也会铺满噪声
  for (const { id, body } of filters) {
    if (!/<feTurbulence\b/.test(body)) continue;
    const last = [...body.matchAll(/<(fe\w+)\b([^>]*)>/g)].filter(m => !/^fe(Func[RGBA]|MergeNode|DistantLight|PointLight|SpotLight)$/.test(m[1])).at(-1);
    // 笔刷色块带 blur（render.mjs brush + blur）：最后一步是模糊推歪后的形状，透明处不会长出噪声，也算收回
    const steps = [...body.matchAll(/<(fe\w+)\b([^>]*)>/g)];
    const shaped = new Set(steps.filter(m => m[1] === 'feDisplacementMap' || (m[1] === 'feComposite' && /operator="(in|atop)"/.test(m[2]))).map(m => m[2].match(/result="([^"]+)"/)?.[1]).filter(Boolean));
    const blurOfShape = last && last[1] === 'feGaussianBlur' && shaped.has(last[2].match(/\sin="([^"]+)"/)?.[1] ?? steps.at(-2)?.[2].match(/result="([^"]+)"/)?.[1]);
    const ok = last && (blurOfShape || last[1] === 'feDisplacementMap' || last[1] === 'feMerge' || (last[1] === 'feComposite' && /operator="(in|atop)"/.test(last[2])));
    if (!ok) E(`滤镜 ${id} 用了噪声，最后一步却没把结果收回形状里（${last?.[1] || '空'}）：Safari 会把整个滤镜区域画成灰块。正式滤镜从 snippets/ 整段复制，别自己写`);
  }
  // 2. 油画棒滤镜要和 snippets/pastel.svg 同一套步骤（参数可以是 A 路线写的别的值，步骤一个不能少）
  const SNIP = path.join(TPL, '..', 'snippets', 'pastel.svg');
  const skel = b => b.replace(/\s+/g, ' ').replace(/\s*\/>/g, '/>').replace(/="-?[\d.]+(?:[ ,]+-?[\d.]+)*"/g, '="#"').trim();
  const canon = fs.existsSync(SNIP) ? fs.readFileSync(SNIP, 'utf8').match(/<filter id="pastel"[^>]*>([\s\S]*?)<\/filter>/)?.[1] : null;
  const pastels = filters.filter(f => /pastel/.test(f.id));
  if (canon) for (const { id, body } of pastels)
    if (skel(body) !== skel(canon)) E(`滤镜 ${id} 和 snippets/pastel.svg 的步骤不一样：油画棒滤镜整段复制，不删、不简写、不凭记忆重写`);
  // 3. 文件名不是渲染能力：叫油画棒版就得真有正式油画棒滤镜
  if (/油画棒|pastel/i.test(path.basename(file)) && !pastels.length)
    E('文件名写着油画棒版，里面却没有正式的 pastel 滤镜：从 snippets/pastel.svg 整段复制；拿不到就只交光滑版，名字写「光滑」，并告诉用户这不是油画棒成品');
}

for (const e of errors) console.log('ERROR', e);
for (const w of warns) console.log('WARN ', w);
console.log(`${file}: ${errors.length} error(s), ${warns.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
