import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };

test('contextual feeling, Pulse, and the autonomous wake record follow a real mock chat flow', async () => {
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
        : '<lumi_pulse>内部状态</lumi_pulse>还惦记着刚才那个玩笑。';
      if (body.messages.findLast(m => m.role === 'user')?.content.includes('<autonomous_wake_context>')) {
        content = '我醒了，来看看你。<sentinel_decision>{"action":"message","nextWakeMinutes":25}</sentinel_decision>';
      }
    }
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: {} }));
  });
  const providerPort = await listen(provider);
  const portProbe = createServer();
  const port = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const env = { ...process.env, PORT: String(port), LUMI_DATA_DIR: folder,
    LUMI_TEST_MODEL_TARGET: `http://127.0.0.1:${providerPort}`, LUMI_MODEL_API_URL: `http://127.0.0.1:${providerPort}/v1`, LUMI_MODEL_API_KEY: 'test-only', LUMI_MODEL_NAME: 'test-model',
    LUMI_MEMORY_API_URL: `http://127.0.0.1:${providerPort}`, LUMI_PUSH_API_TOKEN: 'pulse-test-token', LUMI_BACKGROUND_PULSE_MS: '150', LUMI_CACHE_KEEPALIVE_ENABLED: 'false' };
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
    for (const content of ['拿刚才的小失误开个玩笑', '抱抱，还想着刚才的事吗']) {
      const result = await fetch(`${base}/v1/chats/default/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, provider: 'custom', model: 'test-model', customProvider: { apiKey: 'test', baseURL: 'https://model.test/v1', apiFormat: 'openai' } }) });
      assert.equal(result.status, 200);
      const data = await result.json();
      assert.equal(typeof data.assistantMessage?.content, 'string');
      assert.match(data.assistantMessage.content, /被你逗乐|还惦记/);
      assert.doesNotMatch(data.assistantMessage.content, /<emotion_update|<lumi_pulse|内部状态|"changes"/);
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
    assert.match(nextInput, /<lumi_pulse>当前模拟身体状态：心率 \d+ bpm/);
    assert.equal((await fetch(`${base}/v1/pulse`)).status, 401);
    const headers = { authorization: 'Bearer pulse-test-token' };
    const snapshot = await (await fetch(`${base}/v1/pulse`, { headers })).json();
    assert.equal(snapshot.history.length, 1);
    assert.equal(snapshot.events[0].text, '刚刚的触感还留了一会儿。');
    const interact = () => fetch(`${base}/v1/pulse/interaction`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'pulse-breathe-1' },
      body: JSON.stringify({ action: 'breathe' })
    });
    assert.equal((await interact()).status, 200);
    const replay = await (await interact()).json();
    assert.equal(replay.events.length, snapshot.events.length + 1);
    assert.equal(replay.events[0].text, '呼吸慢慢拉长。');

    const setting = await fetch(`${base}/v1/settings/proactive`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, intervalMin: 30, actions: { message: true, phone: false, screen: false } })
    });
    assert.equal(setting.status, 200);
    const threadPath = join(folder, 'threads.json');
    const threads = JSON.parse(await readFile(threadPath, 'utf8'));
    Object.assign(threads.default.activity, {
      mode: 'sentinel', nextWakeAt: new Date(Date.now() - 1000).toISOString(), sleepPendingAt: null
    });
    await writeFile(threadPath + '.test', JSON.stringify(threads));
    await rename(threadPath + '.test', threadPath);
    let events = [];
    for (let i = 0; i < 100 && !events.some(event => event.wakeRun); i++) {
      const response = await fetch(`${base}/v1/chats/default/activity/history`, { headers });
      assert.equal(response.status, 200);
      events = (await response.json()).events;
      if (!events.some(event => event.wakeRun)) await new Promise(resolve => setTimeout(resolve, 100));
    }
    const root = events.find(event => event.wakeRun);
    assert.equal(root?.title, '自主唤醒');
    const run = root.wakeRun;
    assert.ok(Date.parse(run.finishedAt) >= Date.parse(run.startedAt));
    assert.ok(Date.parse(run.nextWakeAt) > Date.parse(run.finishedAt));
    assert.equal(run.stepIDs.length, 1);
    const contact = events.find(event => event.id === run.stepIDs[0]);
    assert.equal(contact?.kind, 'message');
    assert.equal(contact?.content, '我醒了，来看看你。');
    assert.equal(contact.wakeStep.succeeded, true);
    assert.ok(Date.parse(contact.wakeStep.occurredAt) >= Date.parse(run.startedAt));
    const wakePrompt = requests.at(-1).messages.findLast(m => m.role === 'user').content;
    assert.match(wakePrompt, /<autonomous_wake_context>/);
    assert.match(wakePrompt, /<lumi_pulse>当前模拟身体状态：心率 \d+ bpm/);
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
