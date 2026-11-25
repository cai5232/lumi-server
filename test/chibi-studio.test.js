import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { readChibi, renderChibiImage, prepareChibi, checkChibi, sendChibiDraft } from '../src/chibi-studio.js';
import { sdkToolResponse, TOOL_IMAGES } from '../src/tool-media.js';
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
    const result = await renderChibiImage(dir, { document, caption: '纯本地渲染测试', preview_only: false });
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


test('full studio: original geometry, upstream scripts/lint, visual references and private draft then send', async () => {
  const dir = await mkdtemp(join(tmpdir(),'lumi-chibi-draft-'));
  try {
    for(const template of (await readChibi()).files.filter(path=>path.startsWith('templates/')&&path.endsWith('.chibi.json'))) assert.ok((await prepareChibi({template})).parts.length, template);
    const original=JSON.parse((await readChibi('templates/小狐狸1.chibi.json')).content);
    const doc=await prepareChibi({template:'templates/小狐狸1.chibi.json',sitting:true,patches:[{name:'头',changes:{fill:'#e6c8b2'}}]});
    assert.deepEqual(doc.parts.find(p=>p.name==='右眼底'),original.parts.find(p=>p.name==='右眼底'),'native sit script and named patches keep original face geometry');
    assert.equal(doc.from,'小狐狸1');
    const kit=await prepareChibi({template:'templates/小狐狸1.chibi.json',kits:[{name:'叶形耳',placement:'鹿'}]});
    assert.ok(kit.source.includes('拼装'));
    const lint=await checkChibi({template:'templates/小狐狸1.chibi.json'});
    assert.equal(lint.ok,true,lint.report);
    const bad=structuredClone(original);bad.parts.find(p=>p.name==='右眼底').clip='missing';
    assert.equal((await checkChibi({document:bad})).ok,false);
    await assert.rejects(checkChibi({document:{...original,from:'../../private'}}));
    const reference=await readChibi('templates/总览.png');
    assert.equal(sdkToolResponse(reference).content[1].type,'image');
    assert.ok(!JSON.stringify(reference).includes('base64'));
    const draft=await renderChibiImage(dir,{document:doc,preview_only:true},{threadId:'chat-a'});
    assert.ok(draft.draft_id);assert.equal(draft.photo,undefined,'preview is not delivered as a chat image');
    assert.equal(sdkToolResponse(draft).content[1].type,'image','SDK gets the actual raster for visual review');
    assert.ok(!JSON.stringify(draft).includes(draft[TOOL_IMAGES][0].data),'previews stay out of persistent chat trace');
    await assert.rejects(sendChibiDraft(dir,{draft_id:draft.draft_id},'chat-b'));
    const receipt=await sendChibiDraft(dir,{draft_id:draft.draft_id,caption:'自检完成'},'chat-a');
    assert.equal(receipt.display,'image');assert.equal(receipt.photo.caption,'自检完成');
  } finally {await rm(dir,{recursive:true,force:true});}
});
