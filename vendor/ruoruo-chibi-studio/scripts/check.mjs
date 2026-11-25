#!/usr/bin/env node
// 仓库自检：防止仓库自己打自己。零依赖。
//   node scripts/check.mjs
// 查这些：
//   1. schema/ruoruo-chibi.schema.json 能解析，只用了下面认识的关键字，$ref 都能找到
//   2. 所有 .chibi.json 能解析，并通过 schema
//   3. 所有模板和例图的 .chibi.json 能被渲染器读取；有同名 .svg 的，渲染结果要和仓库里的一致
//   4. lint 不把仓库自己的模板、例图、衣柜判成 ERROR
//   5. 模板部件名不再用 Rectangle 23、左耳_2 这类导出名
//   6. Markdown 里的相对链接、「第 N 节」「章节名」引用、命令里的脚本和参数都还存在
// 有 ERROR 退出码为 1。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderChibi } from './render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
const errors = [], warns = [];
const E = m => errors.push(m), W = m => warns.push(m);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out); else if (!/\.bak/.test(e.name)) out.push(f);
  }
  return out;
}
const files = walk(ROOT);
const read = f => fs.readFileSync(f, 'utf8');

// ---------- 1. schema 本身 ----------
const KEYWORDS = new Set(['$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'const', 'enum', 'required',
  'properties', 'additionalProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum',
  'exclusiveMinimum', 'minLength', 'pattern', 'oneOf', 'anyOf', 'allOf', 'if', 'then', 'not']);
const schemaFile = path.join(ROOT, 'schema', 'ruoruo-chibi.schema.json');
let schema = null;
try { schema = JSON.parse(read(schemaFile)); } catch (e) { E(`schema 解析失败：${e.message}`); }
function checkSchema(s, where) {
  if (typeof s === 'boolean') return;
  if (!s || typeof s !== 'object' || Array.isArray(s)) { E(`schema ${where} 不是对象`); return; }
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) E(`schema ${where} 用了 check.mjs 不认识的关键字 ${k}`);
  if (s.$ref && !resolve(s.$ref)) E(`schema ${where} 的 $ref ${s.$ref} 找不到`);
  if (s.pattern) try { new RegExp(s.pattern); } catch { E(`schema ${where} 的 pattern 不是合法正则`); }
  for (const k of ['properties', '$defs']) for (const [n, v] of Object.entries(s[k] || {})) checkSchema(v, `${where}/${k}/${n}`);
  for (const k of ['items', 'additionalProperties', 'if', 'then', 'not']) if (s[k] !== undefined) checkSchema(s[k], `${where}/${k}`);
  for (const k of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) (s[k] || []).forEach((v, i) => checkSchema(v, `${where}/${k}/${i}`));
}
function resolve(ref) {
  if (!ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').reduce((o, k) => (o ? o[k] : undefined), schema);
}
if (schema) checkSchema(schema, '#');

// ---------- 最小的 schema 校验器（只认上面那些关键字） ----------
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => t === 'number' ? typeof v === 'number' : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t;
function validate(v, s, at, out) {
  if (s === true) return; if (s === false) { out.push(`${at} 不允许出现`); return; }
  if (s.$ref) return validate(v, resolve(s.$ref), at, out);
  if (s.type && ![].concat(s.type).some(t => isType(v, t))) { out.push(`${at} 应该是 ${[].concat(s.type).join('/')}，现在是 ${typeOf(v)}`); return; }
  if ('const' in s && JSON.stringify(v) !== JSON.stringify(s.const)) out.push(`${at} 应该是 ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) out.push(`${at} 只能是 ${s.enum.join(' / ')}，现在是 ${JSON.stringify(v)}`);
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${at} 不能小于 ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) out.push(`${at} 不能大于 ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) out.push(`${at} 要大于 ${s.exclusiveMinimum}`);
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) out.push(`${at} 不能是空字符串`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) out.push(`${at} 格式不对：${v}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push(`${at} 至少 ${s.minItems} 项`);
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${at} 最多 ${s.maxItems} 项`);
    const pre = s.prefixItems || [];
    v.forEach((x, i) => { const sub = i < pre.length ? pre[i] : s.items; if (sub !== undefined) validate(x, sub, `${at}[${i}]`, out); });
  }
  if (typeOf(v) === 'object') {
    for (const k of s.required || []) if (!(k in v)) out.push(`${at} 缺少必填字段 ${k}`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties && k in s.properties) validate(x, s.properties[k], `${at}.${k}`, out);
      else if (s.additionalProperties !== undefined) validate(x, s.additionalProperties, `${at}.${k}`, out);
    }
  }
  const ok = sub => { const o = []; validate(v, sub, at, o); return o.length === 0; };
  if (s.oneOf) { const n = s.oneOf.filter(ok).length; if (n !== 1) out.push(`${at} 的写法不符合任何一种允许的形式`); }
  if (s.anyOf && !s.anyOf.some(ok)) out.push(`${at} 的写法不符合任何一种允许的形式`);
  for (const sub of s.allOf || []) validate(v, sub, at, out);
  if (s.if && ok(s.if) && s.then) validate(v, s.then, at, out);
  if (s.not && ok(s.not)) out.push(`${at} 用了不允许的写法`);
}

// ---------- 2–3. chibi 文件 ----------
const FIGMA = /^(Rectangle|Star|Ellipse|Line|Vector|Group|Union|Polygon|Frame) \d+|_\d+$/;
const chibis = files.filter(f => f.endsWith('.chibi.json'));
let rendered = 0;
for (const f of chibis) {
  let doc;
  try { doc = JSON.parse(read(f)); } catch (e) { E(`${rel(f)} 不是合法 JSON：${e.message}`); continue; }
  if (schema) {
    const out = []; validate(doc, schema, '$', out);
    for (const m of out.slice(0, 8)) E(`${rel(f)} schema：${m}`);
    if (out.length > 8) E(`${rel(f)} schema：还有 ${out.length - 8} 条`);
  }
  let svg;
  try { svg = renderChibi(doc); rendered++; } catch (e) { E(`${rel(f)} 渲染器读取失败：${e.message}`); continue; }
  const pair = f.replace(/\.chibi\.json$/, '.svg');
  if (fs.existsSync(pair) && read(pair).replace(/\r\n/g, '\n').trim() !== svg.replace(/\r\n/g, '\n').trim())
    E(`${rel(pair)} 和 ${rel(f)} 渲染出来的不一致：改了 JSON 后重新运行 node scripts/render.mjs ${rel(f)} ${rel(pair)}`);
  if (rel(f).startsWith('templates/')) {
    const bad = doc.parts.flatMap(p => [p.name, p.mirrorName]).filter(n => n && FIGMA.test(n));
    if (bad.length) E(`${rel(f)} 有导出名部件（${bad.slice(0, 4).join('、')}…）：改成「左眼底」「鼻子」这类部位名`);
  }
  if (doc.action) for (const m of checkAction(doc)) E(`${rel(f)} 声明了「${doc.action.type}」，但${m}`);
}

// ---------- 动作声明：查声明的改动真的做到了，没声明的部件没被动 ----------
function checkAction(doc) {
  const out = [], a = doc.action;
  const src = path.join(ROOT, 'templates', `${a.from}.chibi.json`);
  if (!fs.existsSync(src)) return [`找不到原模板 templates/${a.from}.chibi.json`];
  const tpl = JSON.parse(read(src));
  const byName = ps => new Map(ps.map(p => [p.name, p]));
  const T = byName(tpl.parts), D = byName(doc.parts);
  const ys = p => p.pts.map(q => q[1]), h = p => Math.max(...ys(p)) - Math.min(...ys(p));
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  if (a.type === '坐下') {
    const legs = [...D.keys()].filter(n => /^(左腿|右腿|腿左|腿右)$/.test(n));
    const order = doc.parts.map(p => p.name), body = order.indexOf('身体');
    for (const n of legs) {
      const o = T.get(n), p = D.get(n);
      if (!o?.pts || !p?.pts) { out.push(`${n} 在原模板里没有对应的 poly`); continue; }
      if (!(h(p) < h(o) - 0.5)) out.push(`${n} 没有比原来短（原高 ${h(o).toFixed(1)}，现在 ${h(p).toFixed(1)}）`);
      if (!(order.indexOf(n) > body)) out.push(`${n} 还在身体后面一层，坐下的膝盖要压在身体前面`);
      const ox = o.pts.map(q => q[0]), px = p.pts.map(q => q[0]);
      if (!same(ox, px)) out.push(`${n} 的宽度或横向位置变了，坐下只压高度`);
    }
    if (!legs.length) out.push('没有找到腿');
    const t0 = T.get('尾巴'), t1 = D.get('尾巴');
    if ((a.tailTurn || a.tailUp) && t0?.pts && t1?.pts) {
      const [cx, cy] = a.tailRoot || [0, 0], up = a.tailUp || 0;
      const r = Math.PI * (a.tailTurn || 0) / 180, c = Math.cos(r), s = Math.sin(r);
      const want = t0.pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c - up]);
      if (!want.every((q, i) => Math.hypot(q[0] - t1.pts[i][0], q[1] - t1.pts[i][1]) < 0.05))
        out.push(`尾巴不是绕尾根 (${cx}, ${cy}) 转 ${a.tailTurn || 0}°${up ? `、再上提 ${up}` : ''} 得到的`);
    }
    for (const [n, p] of T) {
      if (legs.includes(n) || (n === '尾巴' && (a.tailTurn || a.tailUp))) continue;
      if (!D.has(n)) out.push(`少了部件 ${n}`);
      else if (!same(p, D.get(n))) out.push(`${n} 和原模板不一样，坐下只动腿和尾巴`);
    }
  }
  return out;
}

// ---------- 4. lint 不该判仓库自己的成品非法 ----------
const lintTargets = files.filter(f => /^(templates|examples)\//.test(rel(f)) && (f.endsWith('.chibi.json') || f.endsWith('.svg')));
for (const f of lintTargets) {
  try { execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'lint.mjs'), f], { stdio: 'pipe' }); }
  catch (e) {
    const lines = String(e.stdout || '').split('\n').filter(l => l.startsWith('ERROR')).slice(0, 3);
    const crash = String(e.stderr || e.message).split('\n').find(l => /Error/.test(l)) || '';
    E(`lint 把仓库自己的 ${rel(f)} 判成 ERROR：${lines.join('；') || crash.trim()}`);
  }
}
const svgNames = files.filter(f => f.endsWith('.svg') && rel(f).startsWith('examples/'))
  .map(f => [f, (read(f).match(/data-part="([^"]+)"/g) || []).map(m => m.slice(11, -1)).filter(n => FIGMA.test(n)).length])
  .filter(([, n]) => n);
if (svgNames.length) W(`${svgNames.length} 张例图里还有导出名部件（共 ${svgNames.reduce((a, [, n]) => a + n, 0)} 处），以后改到它们时顺手换成部位名`);

// ---------- 5b. snippets/ 和 render.mjs 是同一套滤镜 ----------
// B 路线只能整段复制 snippets/ 里的正式滤镜。render.mjs 改了滤镜，snippets 要一起改（重跑 node scripts/snippets.mjs）。
{
  const probe = renderChibi({ viewBox: [0, 0, 100, 100], pastel: true, sticker: true,
    parts: [{ name: '色块', pts: [[10, 10], [90, 10], [90, 90], [10, 90]], r: 5, fill: '#ccc', brush: 8 }] });
  const body = (s, id) => s.match(new RegExp(`<filter id="${id}"[^>]*>([\\s\\S]*?)</filter>`))?.[1];
  for (const [file, pairs] of [['pastel.svg', [['pastel', 'pastel'], ['pastel-fine', 'pastel-fine']]], ['sticker.svg', [['sticker', 'sticker-1']]], ['brush.svg', [['brush', 'brush-1']]]]) {
    const f = path.join(ROOT, 'snippets', file);
    if (!fs.existsSync(f)) { E(`少了 snippets/${file}`); continue; }
    const s = read(f);
    for (const [mine, theirs] of pairs) if (!body(s, mine) || body(s, mine) !== body(probe, theirs)) E(`snippets/${file} 的 ${mine} 和 render.mjs 现在的输出不一样：重跑 node scripts/snippets.mjs`);
  }
  // 傻瓜背景的 B 路线版（snippets/衬底/）要和 backdrop.mjs 现在的输出一样
  const { build } = await import('./backdrop-snippets.mjs');
  for (const [name, want] of Object.entries(build())) {
    const f = path.join(ROOT, 'snippets', '衬底', name);
    if (!fs.existsSync(f)) E(`少了 snippets/衬底/${name}：跑 node scripts/backdrop-snippets.mjs`);
    else if (read(f).replace(/\r/g, '') !== want) E(`snippets/衬底/${name} 和 backdrop.mjs 现在的输出不一样：重跑 node scripts/backdrop-snippets.mjs`);
  }
}

// ---------- 6. 文档引用 ----------
const mds = files.filter(f => f.endsWith('.md'));
const headings = new Map(); // 文件 → 标题文字 + 加粗小标题
for (const f of mds) {
  const t = read(f);
  const hs = [...t.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1].trim());
  const bold = [...t.matchAll(/\*\*([^*]+)\*\*/g)].map(m => m[1].replace(/[：:。]$/, '').trim());
  headings.set(f, { hs, all: [...hs, ...bold] });
}
const sections = new Set();
for (const { hs } of headings.values()) for (const h of hs) { const m = h.match(/^(\d+)\./); if (m) sections.add(m[1]); }
const has = (list, name) => list.some(h => h.includes(name));
const scripts = new Map(files.filter(f => rel(f).startsWith('scripts/')).map(f => [path.basename(f), read(f)]));
for (const f of mds) {
  const t = read(f), dir = path.dirname(f);
  for (const m of t.matchAll(/\[[^\]]*\]\(([^)\s]+)\)(「([^」]+)」)?/g)) {
    const target = decodeURI(m[1].split('#')[0]);
    if (/^[a-z]+:/i.test(target) || !target) continue;
    const abs = path.resolve(dir, target);
    if (!fs.existsSync(abs)) { E(`${rel(f)} 链接到不存在的 ${m[1]}`); continue; }
    if (m[3] && abs.endsWith('.md') && !has(headings.get(abs)?.all || [], m[3])) E(`${rel(f)} 引用了 ${target} 里不存在的「${m[3]}」`);
  }
  for (const m of t.matchAll(/第 ?(\d+) ?节(「([^」]+)」)?/g)) {
    if (!sections.has(m[1])) E(`${rel(f)} 引用了不存在的第 ${m[1]} 节`);
    if (m[3] && ![...headings.values()].some(h => has(h.all, m[3]))) E(`${rel(f)} 引用了不存在的「${m[3]}」`);
  }
  for (const m of t.matchAll(/(?:node|python3?(?: -X utf8)?) scripts\/([\w.-]+)([^\n`]*)/g)) {
    const src = scripts.get(m[1]);
    if (!src) { E(`${rel(f)} 的命令用了不存在的 scripts/${m[1]}`); continue; }
    for (const flag of m[2].match(/(?<=\s)--[a-z][\w-]*/g) || []) if (!src.includes(`'${flag}'`) && !src.includes(`"${flag}"`)) E(`${rel(f)} 的命令给 ${m[1]} 传了它不认识的 ${flag}`);
  }
}

for (const e of errors) console.log('ERROR', e);
for (const w of warns) console.log('WARN ', w);
console.log(`check: ${chibis.length} 个 chibi 文件，渲染 ${rendered} 个，lint ${lintTargets.length} 个，文档 ${mds.length} 篇；${errors.length} error(s), ${warns.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
