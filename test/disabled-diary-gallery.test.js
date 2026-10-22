import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const listen = async server => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};

test('disabled diary and gallery cannot read, write or inject memories; normal photo and sticker chat still works', {timeout: 45000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-disabled-features-'));
  const originalDiary = {id: '11111111-1111-4111-8111-111111111111', title: '原有日记', body: '已有内容', createdAt: new Date().toISOString(), lock: {type: 'capsule', unlockAt: '2099-01-01T00:00:00.000Z'}};
  await writeFile(join(directory, 'threads.json'), JSON.stringify({default: {id: 'default', messages: [], diaries: [originalDiary]}}));
  const mirror = JSON.stringify({default: [originalDiary]});
  await writeFile(join(directory, 'diaries.json'), mirror);
  const requests = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.writeHead(200, {'content-type': 'application/json'});
    if (req.url.includes('/api/integrations/')) return res.end('{"related":""}');
    if (req.method === 'GET') return res.end('[]');
    requests.push(JSON.parse(raw));
    const content = '照片收到了。'
      + '<diary_entry>{"shouldWrite":true,"title":"禁止新增","body":"禁止写入","lock":{"type":"public"}}</diary_entry>'
      + '<diary_action>{"type":"unlock","title":"原有日记"}</diary_action>'
      + '<gallery_collection>{"shouldCollect":true,"title":"禁止收藏","visualDescription":"测试","firstImpression":"测试"}</gallery_collection>';
    res.end(JSON.stringify({choices: [{message: {content}}], usage: {prompt_tokens: 100, completion_tokens: 30}}));
  });
  const target = `http://127.0.0.1:${await listen(provider)}`;
  const probe = createServer(); const port = 20000 + Math.floor(Math.random() * 10000);
  await new Promise(resolve => probe.listen(port, '127.0.0.1', resolve));
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', new URL('./mock-model-fetch.js', import.meta.url).pathname, 'src/index.js'], {
    env: {...process.env, PORT: String(port), LUMI_DATA_DIR: directory, LUMI_PUSH_API_TOKEN: 'test', LUMI_MODEL_API_KEY: 'test', LUMI_TEST_MODEL_TARGET: target, LUMI_MODEL_API_URL: target + '/v1', LUMI_MEMORY_API_URL: target, LUMI_MODEL_NAME: 'test-model', LUMI_CACHE_KEEPALIVE_ENABLED: 'false', LUMI_PROMISE_ALARM_ENABLED: 'false', DUETTO_INTERNAL_PORT: '0'},
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = ''; child.stderr.on('data', chunk => errors += chunk);
  const headers = {'content-type': 'application/json', authorization: 'Bearer test'};
  const request = (path, method = 'GET', data) => fetch(base + path, {method, headers, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
  const route = {provider: 'custom', model: 'test-model', customProvider: {apiKey: 'test', baseURL: 'https://model.test/v1', apiFormat: 'openai'}};
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, errors);
    for (const [path, method, data] of [
      ['/v1/chats/default/diaries', 'GET'],
      [`/v1/chats/default/diaries/${originalDiary.id}/unlock`, 'POST', {answer: 'test'}],
      ['/v1/chats/default/gallery', 'GET'],
      ['/v1/chats/default/gallery', 'POST', {images: ['data:image/png;base64,iVBORw0KGgo=']}],
      [`/v1/chats/default/gallery/${'a'.repeat(64)}/use`, 'POST', {}]
    ]) {
      const res = await request(path, method, data);
      assert.equal(res.status, 410, path);
      assert.equal((await res.json()).error, 'feature_disabled');
    }
    assert.equal((await fetch(base + '/v1/chats/default/diaries')).status, 401);
    const blocked = await request('/v1/chats/default/messages', 'POST', {...route, content: '使用相册', galleryImageIDs: ['a'.repeat(64)]});
    assert.equal(blocked.status, 410);
    assert.equal(requests.length, 0, 'disabled requests never invoke the model');
    const reply = await request('/v1/chats/default/messages', 'POST', {...route, content: '看看这张照片', images: ['data:image/png;base64,iVBORw0KGgo=']});
    assert.equal(reply.status, 200, await reply.clone().text());
    const result = await reply.json();
    assert.equal(result.assistantMessage.content, '照片收到了。');
    assert.deepEqual(result.galleryItems, []);
    assert.deepEqual(result.galleryMessages, []);
    const prompt = requests.find(payload => Array.isArray(payload.messages)).messages.find(message => message.role === 'system').content;
    assert.ok(prompt.includes('<disabled_features>'));
    assert.ok(!prompt.includes('【共同相册】'));
    assert.ok(!prompt.includes('【日记】'));
    const stored = JSON.parse(await readFile(join(directory, 'threads.json'), 'utf8'));
    assert.deepEqual(stored.default.diaries, [originalDiary], 'no append, unlock or retime');
    assert.equal(await readFile(join(directory, 'diaries.json'), 'utf8'), mirror, 'legacy mirror untouched');
    assert.ok(!(await readdir(directory)).includes('gallery'), 'photo was not collected');
    const sticker = await request('/v1/stickers', 'POST', {name: '测试表情', category: '测试', dataURL: 'data:image/png;base64,iVBORw0KGgo='});
    assert.equal(sticker.status, 201, 'shared stickers remain available');
  } finally {
    if (child.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done; }
    await new Promise(resolve => provider.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});
