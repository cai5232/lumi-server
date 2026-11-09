import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmotionState } from '../src/emotion-native.js';

const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };

test('Dayflow rotates a legacy conversation at 230000 and a normal chat succeeds without deleting archive', async () => {
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
    if (body.messages?.[0]?.content?.includes('You rebuild compact working state')) {
      return res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({entries:[{type:'relation',fact:'言言希望约定被记住',temporal:'evergreen',status:'stable',sourceAt:'2026-11-09T11:00:00Z'}],bridge:'约定的话题仍未结束'})},finish_reason:'stop'}]}));
    }
    if (main) {
      requests.push(body);

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
  const prior=[{id:'legacy-end',role:'assistant',content:'旧聊天',createdAt:'2026-11-08T01:00:00Z'},...Array.from({length:24},(_,i)=>({id:'past-'+i,role:i%2?'assistant':'user',content:'这是当前会话里需要保留的原文。'.repeat(100)+i,createdAt:new Date(Date.parse('2026-11-09T01:00:00Z')+i*60000).toISOString()}))];
  await writeFile(join(folder,'context-compression.json'),JSON.stringify({triggerTokens:230000}));
  await writeFile(join(folder,'threads.json'),JSON.stringify({default:{id:'default',title:'test',messages:prior,compactedThroughMessageId:'legacy-end',contextSummary:'旧摘要的重要承诺',lastMeasuredInputTokens:230001,compactionCount:475}}));
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
    const response=await fetch(`${base}/v1/chats/default/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'还记得我们的约定吗',provider:'custom',model:'test-model',customProvider:{apiKey:'test',baseURL:'https://model.test/v1',apiFormat:'openai'}})});
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
    const saved=JSON.parse(await readFile(join(folder,'threads.json'),'utf8')).default;
    assert.equal(saved.messages.length,prior.length+2);assert.equal(saved.contextSummary,'旧摘要的重要承诺');assert.equal(saved.compactionCount,475);
    const sent=requests[0].messages.map(m=>String(m.content)).join('\n');assert.match(sent,/dayflow_state/);assert.match(sent,/言言希望约定被记住/);assert.match(sent,/旧摘要的重要承诺/);
    const health=await (await fetch(base+'/health')).json();assert.equal(health.dayflow.budget.activateTokens,230000);assert.equal(health.dayflow.rotations,1);assert.equal(health.dayflow.archivePreserved,true);
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
