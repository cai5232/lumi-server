#!/usr/bin/env node
// 打包网页沙盒 / Skill 分发用精简 zip（零依赖，原生 zlib + UTF-8 文件名标记，带顶层目录）。
//   node scripts/pack-skill.mjs
//   node scripts/pack-skill.mjs --out dist/custom.zip
//   node scripts/pack-skill.mjs --no-examples
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOP_DIR = 'ruoruo-chibi-studio';

const args = process.argv.slice(2);
let outFile = path.join(ROOT, 'dist', 'ruoruo-chibi-studio-skill.zip');
let includeExamples = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) outFile = path.resolve(ROOT, args[++i]);
  else if (args[i] === '--no-examples') includeExamples = false;
}

const EXCLUDE_DIRS = new Set(['.git', '.github', 'node_modules', 'dist', '__pycache__']);
const EXCLUDE_EXACT = new Set([
  '.gitignore',
  '.gitattributes',
  'README.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'scripts/pack-skill.mjs',
  'templates/衣柜/试穿图.png',
]);

function shouldInclude(rel) {
  if (EXCLUDE_EXACT.has(rel)) return false;
  if (/\.bak/.test(rel)) return false;
  if (rel.startsWith('examples/')) {
    if (!includeExamples) return false;
    // 网页沙盒运行包仅保留 SKILL.md 引用的 SVG/JSON 例图，跳过成品 PNG 大图
    if (rel.endsWith('.png')) return false;
  }
  return true;
}

function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      collect(path.join(dir, e.name), out);
    } else {
      const full = path.join(dir, e.name);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (shouldInclude(rel)) out.push({ full, rel });
    }
  }
  return out;
}

// CRC32 表
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const UTF8_FLAG = 0x0800;

  for (const { full, rel } of entries) {
    const raw = fs.readFileSync(full);
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const data = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(`${TOP_DIR}/${rel}`, 'utf8');

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5421, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5421, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localParts.push(local, data);
    centralParts.push(central);
    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

const entries = collect(ROOT);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const zipBuf = buildZip(entries);
fs.writeFileSync(outFile, zipBuf);
console.log(`pack-skill: ${entries.length} files -> ${path.relative(ROOT, outFile)} (${(zipBuf.length / 1024).toFixed(1)} KB)`);
