import { readFile, readdir, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { applyKits } from '../vendor/ruoruo-chibi-studio/scripts/kit.mjs';
import { sitDown } from '../vendor/ruoruo-chibi-studio/scripts/sit.mjs';
import { backdrop } from '../vendor/ruoruo-chibi-studio/scripts/backdrop.mjs';
import { withToolImages } from './tool-media.js';
const root = fileURLToPath(new URL('../vendor/ruoruo-chibi-studio/', import.meta.url));
export const CHIBI_RENDER_TOOL = 'lumi_chibi_render';
const drawingProperties = {
  document: { type: 'object', description: '完整 chibi JSON；已有模板时优先填 template，避免手工重写五官。', additionalProperties: true },
  template: { type: 'string', description: '原版模板路径，例如 templates/小猫2.chibi.json' },
  patches: { type: 'array', description: '按原部件名称改颜色、点位、表情，未列出的部件逐字沿用模板。', maxItems: 200, items: { type: 'object', properties: { name: { type: 'string' }, changes: { type: 'object', additionalProperties: true } }, required: ['name','changes'], additionalProperties: false } },
  add_parts: { type: 'array', items: { type: 'object', additionalProperties: true }, maxItems: 200 },
  remove_parts: { type: 'array', items: { type: 'string' }, maxItems: 100 },
  kits: { type: 'array', description: '原版部件库拼装，如 {name:"叶形耳",placement:"鹿"}。placement 也可写原版坐标对象。', maxItems: 12, items: { type: 'object', properties: { name: { type: 'string' }, placement: {} }, required: ['name','placement'], additionalProperties: false } },
  sitting: { type: 'boolean', description: '使用原版 sitDown 坐姿脚本' },
  backdrop: { type: 'string', description: '原版 backdrop 风格：色块、几何、网点、涂鸦，按需使用' },
  title: { type: 'string' }
};
export const chibiTools = [
  { name: 'lumi_chibi_read', description: '若若画室完整素材：不填 path 时一次取得 SKILL、模板图册、自检规则和文件列表。可读模板 JSON/SVG、references、examples、snippets、部件库；PNG 会作为真正图片返回供你看模板、五官库和例图。支持 paths 批量读取。先看原画再选模板，不凭空简化五官。', inputSchema: { type: 'object', properties: { path: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, additionalProperties: false } },
  { name: 'lumi_chibi_prepare', description: '用原版模板和脚本准备可编辑 chibi JSON：保留原五官几何，支持按名改部件、原版 kit 拼装、sit 坐姿、backdrop 装饰。返回完整文档供你继续做动作与双人构图。不能执行任意代码。', inputSchema: { type: 'object', properties: drawingProperties, additionalProperties: false } },
  { name: 'lumi_chibi_check', description: '运行上游原版 lint 检查 chibi 文档，包括模板五官、蒙版、比例和配色。返回真实错误/警告，修好再出图。检查不等于发图。', inputSchema: { type: 'object', properties: drawingProperties, additionalProperties: false } },
  { name: CHIBI_RENDER_TOOL, description: '原版油画棒渲染并给你真正的 PNG 视觉预览。先用 preview_only:true 画草稿，看图按 review.md 检查接触点、动作、五官、共同色盘与留白，低于8分继续修；满意后用 lumi_chibi_send 直接发普通图片到聊天。不能因为想快就用圆点或色块替代原模板五官。兼容旧调用：preview_only:false 可直接发图。绘图完全在本地，无付费绘图API。', inputSchema: { type: 'object', properties: { ...drawingProperties, preview_only: { type: 'boolean', default: true }, caption: { type: 'string' } }, additionalProperties: false } },
  { name: 'lumi_chibi_send', description: '把你已看过并自检满意的画室草稿作为普通图片发到当前聊天，可点开大图、长按保存。仅接受本聊天画室实际生成的 draft_id；不发送檐廊卡片、不写HTML。', inputSchema: { type: 'object', properties: { draft_id: { type: 'string' }, caption: { type: 'string' } }, required: ['draft_id'], additionalProperties: false } }
];
async function list(directory = '') {
  const items = await readdir(join(root, directory), { withFileTypes: true });
  const out = [];
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    const path = directory ? `${directory}/${item.name}` : item.name;
    if (item.isDirectory() && ['templates','references','schema','snippets','examples'].includes(path.split('/')[0])) out.push(...await list(path));
    else if (item.isFile() && /\.(md|json|svg|png)$/.test(path)) out.push(path);
  }
  return out;
}
export async function readChibi(path = '') {
  if (!path) return { files: await list(), instructions: await readChibi('SKILL.md'), catalog: await readChibi('templates/catalog.md'), review: await readChibi('references/review.md') };
  if (typeof path !== 'string' || path.includes('..') || path.includes('\\') || !/\.(md|json|svg|png)$/.test(path)) throw Error('invalid_studio_path');
  const target = resolve(root, path);
  if (!target.startsWith(root + (root.endsWith(sep) ? '' : sep)) || !(await list()).includes(path)) throw Error('invalid_studio_path');
  if (path.endsWith('.png')) {
    const preview = await sharp(await readFile(target)).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return withToolImages({ path, note: '原版画室图片，供视觉参考。' }, [{ type: 'image', mimeType: 'image/png', data: preview.toString('base64') }]);
  }
  const content = await readFile(target, 'utf8');
  if (Buffer.byteLength(content) > 180000) throw Error('studio_file_too_large');
  return { path, content };
}
export function validateChibi(document) {
  if (!document || !Array.isArray(document.parts) || document.parts.length > 600 || !Array.isArray(document.viewBox) || document.viewBox.length !== 4 || !document.viewBox.every(Number.isFinite) || document.viewBox[2] < 1 || document.viewBox[3] < 1 || document.viewBox[2] > 1200 || document.viewBox[3] > 1200) throw Error('invalid_chibi_document');
  const body = JSON.stringify(document);
  if (Buffer.byteLength(body) > 600000) throw Error('chibi_document_too_large');
  const visit = (value, depth = 0) => {
    if (depth > 20) throw Error('chibi_document_too_deep');
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1e6)) throw Error('invalid_chibi_number');
    if (typeof value === 'string' && (/[<>"&`=;]/.test(value) || /(?:https?:|file:|data:|@import)/i.test(value))) throw Error('invalid_chibi_string');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (['__proto__','constructor','prototype'].includes(key)) throw Error('invalid_chibi_key');
      // Upstream provenance text contains punctuation (e.g. kit name=placement).
      // It is not rendered; title is escaped by the original renderer.
      if (depth === 0 && ['source','schema','title'].includes(key)) { if (typeof child !== 'string') throw Error('invalid_chibi_metadata'); continue; }
      visit(child, depth + 1);
    }
  };
  visit(document);
  return JSON.stringify({ ...document, pastel: document.pastel ?? true });
}
export async function renderChibiImage(dataDir, args, { threadId = "", publicBaseURL = process.env.LUMI_PUBLIC_BASE_URL || 'https://lumi-api.yanvn.top' } = {}) {
  const document = await prepareChibi(args);
  const input = validateChibi(document);
  const checks = await checkChibi({ document });
  if (!checks.ok) return { ok: false, isError: true, error: '原版画室校验未通过，请按报告修正后重试。', report: checks.report };
  const png = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./chibi-render-worker.js', import.meta.url))], { stdio: ['pipe','pipe','pipe'], env: { PATH: process.env.PATH } });
    const chunks = []; let size = 0; let errorText = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('chibi_render_timeout')); }, 60000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 12000000) { child.kill('SIGKILL'); reject(Error('chibi_image_too_large')); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-1000); });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error(`chibi_render_failed: ${errorText}`)); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
  const id = randomUUID().replaceAll('-', '');
  const directory = join(dataDir, 'chibi-images'); await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${id}.tmp`);
  try { await writeFile(temporary, png, { mode: 0o600, flag: 'wx' }); await rename(temporary, join(directory, `${id}.png`)); }
  finally { await unlink(temporary).catch(() => {}); }
  const receipt = { ok: true, photo: { imageURL: new URL(`/v1/chibi/images/${id}.png`, publicBaseURL).href, title: String(document.title || '给言言的画').slice(0, 200), caption: String(args.caption || '').slice(0, 1500), sourceURL: 'https://github.com/ruo-rongyu/ruoruo-chibi-studio', credit: '若若的小动物画室 · CC BY-NC 4.0' }, display: 'image', note: '画作已作为普通图片加入本轮聊天，可长按保存。' };
  const draftDir = join(dataDir, 'chibi-drafts'); await mkdir(draftDir, { recursive: true });
  await writeFile(join(draftDir, `${id}.json`), JSON.stringify({ threadId, receipt, document }), { flag: 'wx', mode: 0o600 });
  const result = args.preview_only !== false
    ? { ok: true, draft_id: id, title: receipt.photo.title, checks, note: '这是私有草稿，尚未发给言言。请看实际图片按 review.md 自检，满意后调用 lumi_chibi_send。' }
    : receipt;
  const preview = await sharp(png).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return withToolImages(result, [{ type: 'image', mimeType: 'image/png', data: preview.toString('base64') }]);
}
export async function prepareChibi(args) {
  let doc;
  if (args.template) {
    if (typeof args.template !== 'string' || !args.template.startsWith('templates/') || !args.template.endsWith('.chibi.json')) throw Error('invalid_studio_template');
    doc = JSON.parse((await readChibi(args.template)).content);
    doc.from = args.template.slice('templates/'.length, -'.chibi.json'.length);
  } else doc = structuredClone(args.document);
  validateChibi(doc);
  if (args.kits?.length) doc = applyKits(doc, args.kits.map(kit => [kit.name, kit.placement]));
  if (args.sitting === true) doc = sitDown(doc);
  for (const patch of args.patches || []) {
    const part = doc.parts.find(part => part.name === patch.name);
    if (!part) throw Error(`模板没有部件：${patch.name}`);
    if (Object.keys(patch.changes).some(key => ['__proto__','constructor','prototype'].includes(key))) throw Error('invalid_chibi_key');
    Object.assign(part, patch.changes);
  }
  if (args.remove_parts?.length) doc.parts = doc.parts.filter(part => !args.remove_parts.includes(part.name));
  if (args.add_parts?.length) doc.parts.push(...args.add_parts);
  if (args.title) doc.title = args.title;
  validateChibi(doc);
  if (args.backdrop) doc = backdrop(doc, args.backdrop);
  validateChibi(doc);
  return doc;
}

export async function checkChibi(args) {
  const document = await prepareChibi(args);
  for (const from of [document.from, document.action?.from]) {
    if (from !== undefined && (typeof from !== 'string' || /[\\/]|\.\./.test(from) || !(await list()).includes(`templates/${from}.chibi.json`))) throw Error('invalid_studio_template');
  }
  const directory = await mkdtemp(join(tmpdir(), 'lumi-chibi-check-'));
  try {
    const input = join(directory, 'drawing.chibi.json');
    await writeFile(input, JSON.stringify(document), { mode: 0o600 });
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'scripts/lint.mjs'), input], { stdio: ['ignore','pipe','pipe'], env: { PATH: process.env.PATH } });
      let output = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('chibi_check_timeout')); }, 5000);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-20000); });
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, report: output.replaceAll(directory, '[studio]') }); });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function sendChibiDraft(dataDir, args, threadId = '') {
  if (!/^[a-f0-9]{32}$/.test(args.draft_id || '')) throw Error('invalid_draft');
  const saved = JSON.parse(await readFile(join(dataDir, 'chibi-drafts', `${args.draft_id}.json`), 'utf8'));
  if (saved.threadId !== threadId) throw Error('draft_belongs_to_other_chat');
  const receipt = saved.receipt;
  if (args.caption !== undefined) receipt.photo.caption = String(args.caption).slice(0, 1500);
  return receipt;
}
export async function executeChibiTool(name, args, dataDir, { threadId = '' } = {}) {
  if (name === 'lumi_chibi_read') {
    if (!args.paths) return readChibi(args.path);
    const results = await Promise.all(args.paths.slice(0, 8).map(readChibi));
    return withToolImages({ results }, results.flatMap(result => result[Symbol.for('lumi.tool.images')] || []));
  }
  if (name === 'lumi_chibi_prepare') return { document: await prepareChibi(args) };
  if (name === 'lumi_chibi_check') return checkChibi(args);
  if (name === CHIBI_RENDER_TOOL) return renderChibiImage(dataDir, args, { threadId });
  if (name === 'lumi_chibi_send') return sendChibiDraft(dataDir, args, threadId);
  throw Error('unknown_chibi_tool');
}
