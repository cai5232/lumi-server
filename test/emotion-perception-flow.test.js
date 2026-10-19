import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };

test('chat saves a contextual feeling and presents its cause on the next turn without exposing the tag', async () => {
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
      content = requests.length === 1
        ? '被你逗乐了，我也想逗你一下。<emotion_update>{"changes":{"mischief":0.02},"feeling":"被逗乐了","reason":"她拿刚才的小失误打趣"}</emotion_update>'
        : '还惦记着刚才那个玩笑。';
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
    for (let i = 0; i < 100; i++) {
      if (backend.exitCode !== null) throw new Error(`backend exited ${backend.exitCode}`);
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    for (const content of ['拿刚才的小失误开个玩笑', '还想着刚才的事吗']) {
      const result = await fetch(`${base}/v1/chats/default/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, provider: 'custom', model: 'test-model', customProvider: { apiKey: 'test', baseURL: 'https://model.test/v1', apiFormat: 'openai' } }) });
      assert.equal(result.status, 200);
      const data = await result.json();
      assert.equal(typeof data.assistantMessage?.content, 'string');
      assert.match(data.assistantMessage.content, /被你逗乐|还惦记/);
      assert.doesNotMatch(data.assistantMessage.content, /<emotion_update|"changes"/);
    }
    assert.equal(requests.length, 2);
    const nextInput = requests[1].messages.filter(m => m.role === 'user').at(-1).content;
    assert.match(nextInput, /触发：她拿刚才的小失误打趣/);
    assert.match(nextInput, /被逗乐了/);
    assert.match(nextInput, /促狭\+0.02/);
    const system = requests[1].messages.find(m => m.role === 'system').content;
    assert.match(system, /先结合完整对话理解言言此刻的意思与感受/);
    assert.match(system, /不要求每轮变化/);
    const saved = JSON.parse(await readFile(join(folder, 'emotion-state.json'), 'utf8'));
    assert.equal(saved.recentChanges.at(-1).reason, '她拿刚才的小失误打趣');
    assert.ok(Math.abs(saved.drives.mischief - .22) < 1e-9);
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
