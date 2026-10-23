import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('chat creates private commands; authorized actions feed completion into the next successful turn', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-command-api-'));
  const seen = [];
  let reply = '去喝水<countdown>{"title":"喝水","minutes":1}</countdown><countdown>{"title":"整理桌面"}</countdown>';
  let fail = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(200); return res.end('{}'); }
    const payload = JSON.parse(raw); seen.push(payload);
    res.writeHead(fail ? 400 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fail ? { error: { message: 'test model failure' } } : { choices: [{ message: { content: reply } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${provider.address().port}`;
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', new URL('./mock-model-fetch.js', import.meta.url).pathname, 'src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), LUMI_DATA_DIR: directory, LUMI_PUSH_API_TOKEN: 'test', LUMI_TEST_MODEL_TARGET: target, LUMI_MEMORY_API_URL: target, LUMI_CACHE_KEEPALIVE_ENABLED: 'false', LUMI_PROMISE_ALARM_ENABLED: 'false', DUETTO_INTERNAL_PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = ''; child.stderr.on('data', chunk => errors += chunk);
  const request = (path, method = 'GET', data) => fetch(base + path, { method, headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const chat = content => request('/v1/chats/default/messages', 'POST', { content, provider: 'custom', model: 'test-model', customProvider: { apiKey: 'test', baseURL: 'https://model.test/v1', apiFormat: 'openai' } });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, errors);
    assert.equal((await fetch(base + '/v1/chats/default/commands')).status, 401);
    const first = await chat('让我做点事'); assert.equal(first.status, 200, await first.clone().text());
    assert.equal((await first.json()).assistantMessage.content, '去喝水');
    const { items } = await (await request('/v1/chats/default/commands')).json();
    assert.equal(items.length, 2);
    assert.equal(items[0].countdown_seconds, 60);
    assert.equal((await request(`/v1/chats/other/commands/${items[0].id}/complete`, 'POST')).status, 404);
    assert.equal((await request(`/v1/chats/default/commands/${items[1].id}`, 'DELETE')).status, 200);
    assert.equal((await request(`/v1/chats/default/commands/${items[0].id}/complete`, 'POST')).status, 200);
    fail = true;
    assert.notEqual((await chat('这是失败的一轮')).status, 200);
    fail = false; reply = '做完啦';
    assert.equal((await chat('喝好了')).status, 200);
    const latestUser = () => seen.at(-1).messages.filter(message => message.role === 'user').at(-1).content;
    assert.match(latestUser(), /【指令完成反馈】/);
    assert.match(latestUser(), /"喝水"：用时/);
    assert.doesNotMatch(latestUser(), /"整理桌面"：用时/);
    assert.equal((await chat('再聊点别的')).status, 200);
    assert.doesNotMatch(latestUser(), /【指令完成反馈】/);
    assert.deepEqual((await (await request('/v1/chats/default/commands')).json()).items, []);
  } finally {
    if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
    await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
