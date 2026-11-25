import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { readChibi, renderChibiImage } from '../src/chibi-studio.js';
import { editablePrompt } from '../src/editable-prompt.js';

test('original studio template renders durable private PNG with small chat receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lumi-chibi-'));
  try {
    const files = (await readChibi()).files;
    assert.ok(files.includes('SKILL.md'));
    assert.ok(files.includes('references/review.md'));
    await assert.rejects(readChibi('../package.json'));
    await assert.rejects(readChibi('scripts/render.mjs'));
    const document = JSON.parse((await readChibi('templates/小狐狸1.chibi.json')).content);
    document.title = '狐狸试画';
    const result = await renderChibiImage(dir, { document, caption: '纯本地渲染测试' });
    assert.equal(result.ok, true);
    assert.ok(JSON.stringify(result).length < 1500);
    const file = (await readdir(join(dir, 'chibi-images')))[0];
    const png = await readFile(join(dir, 'chibi-images', file));
    const meta = await sharp(png).metadata();
    assert.equal(meta.format, 'png'); assert.equal(meta.width, 1024);
    assert.match(result.photo.imageURL, /\/v1\/chibi\/images\/[a-f0-9]{32}\.png$/);
    // The model cannot turn the renderer into a file/network/script execution tool.
    await assert.rejects(renderChibiImage(dir, { document: { ...document, background: 'url(https://internal/secret)' } }));
    await assert.rejects(renderChibiImage(dir, { document: { ...document, viewBox: [0,0,1e8,1e8] } }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('editable wake prompt preserves bytes, detects stale writes and survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lumi-wake-prompt-'));
  try {
    const initial = '原始规则\n';
    const store = editablePrompt(dir, 'autonomy-prompt', initial);
    assert.equal(await store.read(), initial);
    const revision = store.snapshot(initial).revision;
    const first = await store.save('  用户修改\n\n', revision);
    assert.ok(first);
    assert.equal(await store.save('不应覆盖', revision), null);
    assert.equal(await editablePrompt(dir, 'autonomy-prompt', initial).read(), '  用户修改\n\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
