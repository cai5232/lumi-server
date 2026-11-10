import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmotionState } from '../src/emotion-native.js';

const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };

test('HerVoice acoustic context reaches the model separately from the visible user text', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lumi-emotion-perception-'));
  const requests = [];
  const state = createEmotionState();
  const events = [];
  const engine = createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/emotion/history')) return res.end(JSON.stringify(events));
    if (req.url === '/emotion/state') return res.end(JSON.stringify({ character: 'aria', dimensions: state.dimensions, mood: 'calm', saved_at: Date.now()/1000 }));
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw || '{}');
    if (req.url === '/emotion/update') {
      for (const [key, delta] of Object.entries(payload.dimensions)) state.dimensions[key] += delta;
      if (payload.trigger) events.push({ trigger: payload.trigger, source: payload.source, state: { ...state.dimensions } });
      return res.end(JSON.stringify({ applied: payload.dimensions, state: state.dimensions, mood: 'calm' }));
    }
    return res.end('{"ok":true}');
  });
  const enginePort = await listen(engine);
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
      if (requests.length === 1) { res.statusCode = 502; return res.end(JSON.stringify({error:{message:'temporary relay failure'}})); }
      content = requests.length === 1
        ? '被你逗乐了，我也想逗你一下。<emotion_update>{"dimensions":{"playfulness":0.02},"trigger":"她拿刚才的小失误打趣","moved":false}</emotion_update>'
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
  env.MURMUR_SERVICE_URL = `http://127.0.0.1:${enginePort}`;
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
    const sentAt='2026-11-09T11:20:00Z';
    const post=async(content,extra={})=>fetch(`${base}/v1/chats/default/messages`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content,context:'用户发送真实语音，Groq 转写：测试；音高比平时低，停顿较多。',requestedAt:sentAt,provider:'custom',model:'test-model',customProvider:{apiKey:'test',baseURL:'https://model.test/v1',apiFormat:'openai'},...extra})});
    let response=await post('第一条发出却报错的消息');
    assert.equal(response.status,502);
    response=await post('第二条消息');assert.equal(response.status,200);
    const next=requests[1].messages.filter(m=>m.role==='user').at(-1).content;
    assert.match(next,/<request_failures/);assert.match(next,/第一条发出却报错的消息/);assert.match(next,/temporary relay failure/);assert.match(next,/2026-11-09T11:20:00/);
    const saved=JSON.parse(await readFile(join(folder,'request-failures.json'),'utf8'));
    assert.ok(saved.events.every(e=>e.deliveredAt));
    response=await post('第三条消息',{previousRequestFailures:[{id:'offline-one',requestId:'offline-one',message:'离线时我发过的话',error:'network disconnected',requestedAt:sentAt,failedAt:sentAt,timeZone:'Asia/Shanghai'}]});assert.equal(response.status,200);
    const last=requests[2].messages.filter(m=>m.role==='user').at(-1).content;
    assert.match(last,/离线时我发过的话/);assert.match(last,/network disconnected/);
    assert.equal((last.match(/<request_failures/g)||[]).length,1);
    assert.match(last,/第一条发出却报错的消息/);assert.match(last,/temporary relay failure/);
    assert.match(last,/deliveredAt/);assert.match(last,/retention="recent-history"/);
    response=await post('第四条消息，继续聊刚才的问题');assert.equal(response.status,200);
    const fourth=requests[3].messages.filter(m=>m.role==='user').at(-1).content;
    assert.match(fourth,/第一条发出却报错的消息/);assert.match(fourth,/network disconnected/);
    assert.equal((fourth.match(/<request_failures/g)||[]).length,1);

    assert.ok(requests.some(body => JSON.stringify(body.messages).includes('<her_voice')));
    assert.ok(requests.some(body => JSON.stringify(body.messages).includes('音高比平时低')));
  } finally {
    if (backend.exitCode === null) {
      const exit = new Promise(resolve => backend.once('exit', resolve));
      backend.kill();
      await exit;
    }
    await new Promise(resolve => provider.close(resolve));
    await new Promise(resolve => engine.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
