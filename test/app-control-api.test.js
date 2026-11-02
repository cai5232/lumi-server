import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('app restrictions require authentication and model tool changes enrolled apps', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-command-api-'));
  const seen = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!req.url.endsWith('/chat/completions')) return res.end('{}');
    const payload = JSON.parse(raw); seen.push(payload);
    const hasResult = payload.messages.some(m => m.role === 'tool');
    const message = hasResult ? { content: '已经限制' } : { content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'lumi_app_control', arguments: JSON.stringify({action:'block', app:'抖音', minutes:10}) } }] };
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${provider.address().port}`;
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', new URL('./mock-model-fetch.js', import.meta.url).pathname, 'src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), LUMI_DATA_DIR: directory, LUMI_PUSH_API_TOKEN: 'test', SENTINEL_INGEST_TOKEN: 'shortcut-test', LUMI_TEST_MODEL_TARGET: target, LUMI_MEMORY_API_URL: target, LUMI_CACHE_KEEPALIVE_ENABLED: 'false', LUMI_PROMISE_ALARM_ENABLED: 'false', DUETTO_INTERNAL_PORT: '0' },
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
    assert.equal((await fetch(base + '/v1/app-control')).status, 401);
    assert.equal((await fetch(base + '/v1/sentinel/app-control?app=抖音')).status, 401);
    assert.equal((await fetch(base + '/v1/app-control', {method:'DELETE',headers:{authorization:'Bearer shortcut-test'}})).status, 401);
    assert.equal((await request('/v1/app-control', 'PUT', {apps:['抖音'],autonomous:false})).status, 200);
    const first = await chat('帮我限制抖音十分钟'); assert.equal(first.status, 200, await first.clone().text());
    assert.ok(seen[0].tools.some(t => t.function.name === 'lumi_app_control'));
    const check = await fetch(base + '/v1/sentinel/app-control?app='+encodeURIComponent('抖音'), {headers:{authorization:'Bearer shortcut-test'}});
    assert.equal(check.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await check.json(), {blocked:true});
    const event = await fetch(base + '/v1/sentinel/events', {method:'POST',headers:{authorization:'Bearer shortcut-test','content-type':'application/json'},body:JSON.stringify({app:'抖音'})});
    assert.equal((await event.json()).blocked,true);
    assert.equal((await request('/v1/app-control', 'DELETE')).status, 200);
    assert.equal((await (await fetch(base + '/v1/sentinel/app-control?app='+encodeURIComponent('抖音'), {headers:{authorization:'Bearer shortcut-test'}})).json()).blocked,false);

  } finally {
    if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
    await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
