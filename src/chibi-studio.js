import { readFile, readdir, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../vendor/ruoruo-chibi-studio/', import.meta.url));
export const CHIBI_RENDER_TOOL = 'lumi_chibi_render';
export const chibiTools = [
  { name: 'lumi_chibi_read', description: '若若的小动物画室：先读取 SKILL.md 和 templates/catalog.md，再按需读取 templates/*.chibi.json、references/*.md。path 为空列出可用文件。只读画室素材，无终端或其他文件访问。', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: CHIBI_RENDER_TOOL, description: '用若若画室的原版渲染器画小动物，并直接把 PNG 成品送到本轮聊天，言言可以长按保存。先读 SKILL.md、模板和 review.md，修改模板的 chibi JSON 后填写 document（完整 ruoruo-chibi 文档），默认 pastel 油画棒。可以组合多只动物的 parts（需给名称及蒙版引用加前缀）；不可执行代码、联网或调用付费绘图。成功后自然说话，不必再写图片 Markdown。', inputSchema: { type: 'object', properties: { document: { type: 'object', description: '完整 chibi JSON，含 viewBox、parts、title；可从画室模板修改。', additionalProperties: true }, caption: { type: 'string' } }, required: ['document'], additionalProperties: false } }
];
async function list(directory = '') {
  const items = await readdir(join(root, directory), { withFileTypes: true });
  const out = [];
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    const path = directory ? `${directory}/${item.name}` : item.name;
    if (item.isDirectory() && ['templates','references','schema','snippets','examples'].includes(path.split('/')[0])) out.push(...await list(path));
    else if (item.isFile() && /\.(md|json|svg)$/.test(path)) out.push(path);
  }
  return out;
}
export async function readChibi(path = '') {
  if (!path) return { files: await list(), start: 'SKILL.md' };
  if (typeof path !== 'string' || path.includes('..') || path.includes('\\') || !/\.(md|json|svg)$/.test(path)) throw Error('invalid_studio_path');
  const target = resolve(root, path);
  if (!target.startsWith(root + (root.endsWith(sep) ? '' : sep)) || !(await list()).includes(path)) throw Error('invalid_studio_path');
  const content = await readFile(target, 'utf8');
  if (Buffer.byteLength(content) > 180000) throw Error('studio_file_too_large');
  return { path, content };
}
function validate(document) {
  if (!document || !Array.isArray(document.parts) || document.parts.length > 600 || !Array.isArray(document.viewBox) || document.viewBox.length !== 4 || !document.viewBox.every(Number.isFinite) || document.viewBox[2] < 1 || document.viewBox[3] < 1 || document.viewBox[2] > 1200 || document.viewBox[3] > 1200) throw Error('invalid_chibi_document');
  const body = JSON.stringify(document);
  if (Buffer.byteLength(body) > 600000) throw Error('chibi_document_too_large');
  const visit = (value, depth = 0) => {
    if (depth > 20) throw Error('chibi_document_too_deep');
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1e6)) throw Error('invalid_chibi_number');
    if (typeof value === 'string' && (/[<>"&`=;]/.test(value) || /(?:https?:|file:|data:|@import)/i.test(value))) throw Error('invalid_chibi_string');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (['__proto__','constructor','prototype'].includes(key)) throw Error('invalid_chibi_key'); visit(child, depth + 1); }
  };
  visit(document);
  return JSON.stringify({ ...document, pastel: document.pastel ?? true });
}
export async function renderChibiImage(dataDir, args, { publicBaseURL = process.env.LUMI_PUBLIC_BASE_URL || 'https://lumi-api.yanvn.top' } = {}) {
  const input = validate(args.document);
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
  return { ok: true, photo: { imageURL: new URL(`/v1/chibi/images/${id}.png`, publicBaseURL).href, title: String(args.document.title || '给言言的画').slice(0, 200), caption: String(args.caption || '').slice(0, 1500), sourceURL: 'https://github.com/ruo-rongyu/ruoruo-chibi-studio', credit: '若若的小动物画室 · CC BY-NC 4.0' }, display: 'photo_card', note: 'PNG 画作已加入本轮聊天，可长按保存。' };
}
export async function executeChibiTool(name, args, dataDir) {
  if (name === 'lumi_chibi_read') return readChibi(args.path);
  if (name === CHIBI_RENDER_TOOL) return renderChibiImage(dataDir, args);
  throw Error('unknown_chibi_tool');
}
