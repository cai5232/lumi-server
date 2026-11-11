import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('live keepsake routes require auth; pending notes reach the next model turn and AI writes persist', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-keepsake-api-'));
  const messages = [
    { id: 'first', role: 'user', content: '外面下雨了', createdAt: new Date().toISOString() },
    { id: 'second', role: 'assistant', content: '那就慢慢走，我陪你。', createdAt: new Date().toISOString() }
  ];
  await writeFile(join(directory, 'threads.json'), JSON.stringify({ default: { id: 'default', title: 'test', messages } }));
  const seen = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!req.url.endsWith('/chat/completions')) return res.end('{}');
    seen.push(JSON.parse(raw));
    res.end(JSON.stringify({ choices: [{ message: { content: '我记得。⟪泡:k:1#1|那天雨很大⟫⟪前情:k:1|我们一起回家⟫' } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', new URL('./mock-model-fetch.js', import.meta.url).pathname, 'src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), LUMI_DATA_DIR: directory, LUMI_PUSH_API_TOKEN: 'test', LUMI_TEST_MODEL_TARGET: `http://127.0.0.1:${provider.address().port}`, LUMI_MEMORY_API_URL: `http://127.0.0.1:${provider.address().port}`, LUMI_CACHE_KEEPALIVE_ENABLED: 'false', LUMI_PROMISE_ALARM_ENABLED: 'false', DUETTO_INTERNAL_PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = ''; child.stderr.on('data', data => errors += data);
  const request = (path, method = 'GET', data) => fetch(base + '/v1/chats/default' + path, { method, headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, errors);
    assert.equal((await fetch(base + '/v1/chats/default/keepsakes')).status, 401);
    assert.equal((await request('/keepsakes', 'POST', { msg_ids: ['unknown'] })).status, 400);
    const created = await request('/keepsakes', 'POST', { msg_ids: ['second'], title: '雨夜', send: true });
    assert.equal(created.status, 200, await created.clone().text());
    const { item } = await created.json(); assert.equal(item.key, 'k:1');
    assert.equal((await request('/keepsakes/meta', 'PUT', { key: item.key, askMe: true })).status, 200);
    assert.equal((await request('/keepsakes/comments', 'POST', { key: item.key, text: '你还记得吗', send: true })).status, 200);
    const chat = await request('/messages', 'POST', { content: '晚上好', provider: 'custom', model: 'test-model', customProvider: { apiKey: 'test', baseURL: 'https://model.test/v1', apiFormat: 'openai' } });
    assert.equal(chat.status, 200, await chat.clone().text());
    assert.ok(seen.some(payload => JSON.stringify(payload.messages).includes('你还记得吗')));
    const [saved] = (await (await request('/keepsakes')).json()).items;
    assert.equal(saved.notes.length, 2); assert.equal(saved.notes[1].w, 'ta');
    assert.equal(saved.notes[1].re, 1); assert.equal(saved.pre.ta, '我们一起回家'); assert.equal(saved.askMe, false);
    assert.equal((await request('/keepsakes/comments', 'DELETE', { key: item.key, id: 1 })).status, 200);
    assert.equal((await request('/keepsakes', 'DELETE', { key: item.key })).status, 200);
    assert.deepEqual((await (await request('/keepsakes')).json()).items, []);
  } finally {
    if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
    await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
