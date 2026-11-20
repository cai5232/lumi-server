import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };

test('failed chat content, error and request time reach the next successful model call', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lumi-emotion-perception-'));
  const requests = [];
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET') return res.end('[]');
    if (req.url.includes('/api/integrations/')) return res.end('{"related":""}');
    const body = JSON.parse(raw);
    const main = body.messages?.some(m => m.role === 'user' && String(m.content).includes('<emotion_state'));
    let content = '{"events":[]}';
    if (main) {
      requests.push(body);
      if (requests.length === 2) { res.statusCode = 502; return res.end(JSON.stringify({error:{message:'temporary relay failure'}})); }
      content = '<request_failure>这段内部标签不能显示</request_failure>还惦记着刚才那个玩笑。';
    }
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: {} }));
  });
  const providerPort = await listen(provider);
  const portProbe = createServer();
  const port = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const env = { ...process.env, PORT: String(port), LUMI_DATA_DIR: folder,
    LUMI_TEST_MODEL_TARGET: `http://127.0.0.1:${providerPort}`, LUMI_MODEL_API_URL: `http://127.0.0.1:${providerPort}/v1`, LUMI_MODEL_API_KEY: 'test-only', LUMI_MODEL_NAME: 'test-model',
    LUMI_MEMORY_API_URL: `http://127.0.0.1:${providerPort}`, LUMI_BACKGROUND_PULSE_MS: '60000', LUMI_CACHE_KEEPALIVE_ENABLED: 'false' };
  delete env.MURMUR_SERVICE_URL;
  const backend = spawn(process.execPath, ['--import', new URL('./mock-model-fetch.js', import.meta.url).pathname, 'src/index.js'], { cwd: new URL('..', import.meta.url), env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) {
      if (backend.exitCode !== null) throw new Error(`backend exited ${backend.exitCode}`);
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    const post = async (content, extra = {}) => fetch(`${base}/v1/chats/default/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, provider: 'custom', model: 'test-model',
        customProvider: { apiKey: 'test', baseURL: 'https://model.test/v1', apiFormat: 'openai' }, ...extra })
    });
    assert.equal((await post('报错前正常发到的消息')).status, 200);
    const sentAt = new Date().toISOString();
    assert.equal((await post('中间发出却报错的消息', { requestedAt: sentAt })).status, 502);
    const response = await post('报错后正常发到的消息');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).assistantMessage.content, '还惦记着刚才那个玩笑。');
    const actual = requests[2].messages;
    const before = actual.findIndex(message => message.content.includes('报错前正常发到的消息'));
    assert.ok(before >= 0 && before < actual.length - 1);
    assert.ok(actual.slice(0, -1).filter(message => message.role !== 'system')
      .every(message => !message.content.includes('<request_failure ')));
    const suffix = actual.at(-1).content;
    assert.match(suffix, /报错后正常发到的消息[\s\S]*<request_failure /);
    assert.match(suffix, /中间发出却报错的消息/);
    assert.match(suffix, /temporary relay failure/);
    assert.ok(suffix.includes(sentAt));
    assert.equal((await post('手机恢复网络后继续', { previousRequestFailures: [{
      id: 'offline-one', requestId: 'offline-one', message: '很早以前离线时发的话',
      error: 'network disconnected Bearer highly-sensitive-test-token',
      requestedAt: '2026-11-09T11:20:00Z', failedAt: '2026-11-09T11:20:00Z', timeZone: 'Asia/Shanghai'
    }] })).status, 200);
    const withOffline = requests[3].messages.filter(message => message.role !== 'system');
    assert.match(withOffline.at(-1).content, /很早以前离线时发的话/);
    assert.match(withOffline.at(-1).content, /network disconnected/);
    assert.doesNotMatch(withOffline.at(-1).content, /highly-sensitive-test-token/);
    assert.ok(withOffline.slice(0, -1).every(message => !message.content.includes('<request_failure')));
    assert.equal((await post('继续聊天')).status, 200);
    const subsequent = requests[4].messages.filter(message => message.role !== 'system');
    assert.ok(subsequent.some(message => message.content.includes('temporary relay failure')));
    assert.ok(!subsequent.some(message => message.content.includes('network disconnected')));
    assert.deepEqual(subsequent.slice(0, withOffline.length - 1), withOffline.slice(0, -1));
    const archive = JSON.parse(await readFile(join(folder, 'request-failures.json'), 'utf8'));
    assert.equal(archive.events.length, 2);
    assert.ok(archive.events.every(event => event.deliveredAt));
    const threads = JSON.parse(await readFile(join(folder, 'threads.json'), 'utf8'));
    assert.ok(threads.default.messages.every(message => !message.modelContent?.includes('<request_failure')));
    assert.equal(threads.default.cacheKeepaliveMessages, null);

  } finally {
    if (backend.exitCode === null) {
      const exit = new Promise(resolve => backend.once('exit', resolve));
      backend.kill();
      await exit;
    }
    await new Promise(resolve => provider.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
