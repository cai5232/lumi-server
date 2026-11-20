import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { configuredZenMuxRoute } from '../src/zenmux-route.js';

const config = {
  LUMI_ZENMUX_ONLY: 'true',
  LUMI_MODEL_API_KEY: 'server-test-key',
  LUMI_MODEL_NAME: 'moonshotai/kimi-k3',
  LUMI_ZENMUX_PROVIDER: 'moonshotai',
  LUMI_PUSH_API_TOKEN: 'lumi-test-token'
};
const pinnedModel = 'moonshotai/kimi-k3:moonshotai';

test('ZenMux-only mode requires a single valid supplier and server credentials', () => {
  assert.equal(configuredZenMuxRoute({}), null);
  assert.equal(configuredZenMuxRoute(config).model, pinnedModel);
  assert.equal(configuredZenMuxRoute({ ...config, LUMI_MODEL_API_KEY: '' }).customProvider.key, '');
  assert.equal(configuredZenMuxRoute({ LUMI_PUSH_API_TOKEN: 'test' }, 'saved-key').model, pinnedModel);
  for (const [key, value] of Object.entries({
    LUMI_PUSH_API_TOKEN: '', LUMI_MODEL_NAME: pinnedModel,
    LUMI_ZENMUX_PROVIDER: 'moonshotai,another-provider'
  })) {
    assert.throws(() => configuredZenMuxRoute({ ...config, [key]: value }), new RegExp(key));
  }
});

test('ZenMux-only chat ignores legacy presets, meters caching and surfaces supplier failures', { timeout: 15000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lumi-zenmux-'));
  const preload = join(dataDir, 'mock-zenmux.mjs');
  const capture = join(dataDir, 'upstream.jsonl');
  await writeFile(preload, `
import { appendFile } from 'node:fs/promises';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input.url || input);
  if (url.hostname === '127.0.0.1') return realFetch(input, options);
  if (['zenmux.ai', 'legacy.test', 'backup.test'].includes(url.hostname)) {
    const body = JSON.parse(options.body);
    await appendFile(${JSON.stringify(capture)}, JSON.stringify({ url: url.href, authorization: options.headers.authorization, body }) + '\\n');
    const currentContent = body.messages.at(-1).content;
    if (typeof currentContent === 'string' && currentContent.split('<request_failure ')[0].includes('模拟上游失败')) {
      return Response.json({ error: { message: 'no available channel' } }, { status: 503 });
    }
    if (url.pathname === '/api/anthropic/v1/messages') {
      const usage = { input_tokens: 512, cache_read_input_tokens: 1024, cache_creation_input_tokens: 512 };
      if (JSON.stringify(body.messages.at(-1)).includes('<autonomous_wake_context>')) {
        return Response.json({
          content: [{ type: 'tool_use', id: 'wake-calendar', name: 'lumi_calendar_2_calendar_create',
            input: { title: 'Should never be created', starts_at: '2026-11-22' } }],
          stop_reason: 'tool_use', usage: { ...usage, output_tokens: 6 }
        });
      }
      const wakeContinuation = Array.isArray(currentContent) && currentContent.some(block => block.tool_use_id === 'wake-calendar');
      const content = { type: 'text', text: wakeContinuation
        ? '我在这里。\\n\\n我去檐廊逛了一圈，看到首诗。<sentinel_decision>{"action":"message","nextWakeMinutes":30}</sentinel_decision>'
        : '我在这里。' };
      if (!body.stream) return Response.json({ content: [content], stop_reason: 'end_turn', usage: { ...usage, output_tokens: 6 } });
      const frames = [
        { type: 'message_start', message: { usage } },
        { type: 'content_block_start', index: 0, content_block: content },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
        { type: 'message_stop' }
      ];
      return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\\n\\n').join(''));
    }
    const usage = { prompt_tokens: 2048, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens: 6 };
    if (!body.stream) return Response.json({ choices: [{ message: { content: '我在这里。' } }], usage });
    const frames = [{ choices: [{ delta: { content: '我在这里。' } }] }, { choices: [], usage }];
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\\n\\n').join('') + 'data: [DONE]\\n\\n');
  }
  throw new Error('External fetch disabled in test');
};
`);
  const launch = (pulseMs = '600000') => spawn(process.execPath, ['--import', preload, 'src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, ...config, LUMI_ZENMUX_ONLY: '', LUMI_MODEL_API_KEY: '',
      PORT: '0', DUETTO_INTERNAL_PORT: '0', LUMI_DATA_DIR: dataDir,
      LUMI_PROMISE_ALARM_ENABLED: 'false', LUMI_CACHE_KEEPALIVE_ENABLED: 'false', LUMI_BACKGROUND_PULSE_MS: pulseMs,
      LUMI_MODEL_API_URL_2: 'https://backup.test/v1', LUMI_MODEL_API_KEY_2: 'backup-test-key'
    },
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const waitForPort = child => new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Lumi server listening on :(\d+)/);
      if (match) resolve(match[1]);
    });
    child.once('exit', code => reject(new Error(`Backend exited before listening (${code})`)));
  });
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  };
  let child = launch();
  try {
    const port = await waitForPort(child);
    const base = `http://127.0.0.1:${port}`;
    const authorization = { authorization: 'Bearer lumi-test-token' };
    const settingsPath = base + '/v1/settings/zenmux';
    const save = (key, headers) => fetch(settingsPath, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ apiKey: key })
    });
    assert.equal((await fetch(settingsPath)).status, 401);
    assert.equal((await save('server-test-key', {})).status, 401);
    assert.deepEqual(await (await fetch(settingsPath, { headers: authorization })).json(),
      { enabled: false, configured: false, model: pinnedModel });
    assert.equal((await save('contains a space', authorization)).status, 400);
    const saved = await save('server-test-key', authorization);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { enabled: true, configured: true, model: pinnedModel });
    const sealed = await readFile(join(dataDir, 'zenmux-key.json'), 'utf8');
    assert.ok(JSON.parse(sealed).tag);
    assert.ok(!sealed.includes('server-test-key'));
    const send = (path, input, headers = authorization) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input)
    });
    const legacy = {
      provider: 'custom', model: 'client-model',
      customProvider: { baseURL: 'https://legacy.test/v1', apiKey: 'client-key', apiFormat: 'anthropic' }
    };
    const messages = '/v1/chats/default/messages';
    assert.equal((await send(messages, { content: '未登录' }, {})).status, 401);
    assert.equal((await send(messages, { content: '第一条' })).status, 200);
    assert.equal((await send(messages, { ...legacy, content: '第二条' })).status, 200);
    const watched = await send('/v1/watch/analyze', {
      image: 'data:image/jpeg;base64,AAAA', analysisConfig: { ...legacy.customProvider, model: legacy.model }
    });
    assert.equal(watched.status, 200);
    assert.equal((await watched.json()).model, pinnedModel);
    assert.equal((await send(messages, { ...legacy, content: '模拟上游失败' })).status, 503);
    const updatedSchedule = await fetch(base + '/v1/settings/proactive', {
      method: 'PUT', headers: { 'content-type': 'application/json', ...authorization },
      body: JSON.stringify({ enabled: true, intervalMin: 120, intervalMax: 240 })
    });
    assert.equal(updatedSchedule.status, 200);
    const schedule = await updatedSchedule.json();
    assert.equal(schedule.intervalMin, 50);
    assert.equal(schedule.intervalMax, 50);
    assert.ok(Date.parse(schedule.nextDueAt) - Date.now() <= 50 * 60_000);
    assert.ok(Date.parse(schedule.nextDueAt) - Date.now() >= 49 * 60_000);

    const records = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 4);
    for (const record of records) {
      assert.equal(record.authorization, 'Bearer server-test-key');
      assert.equal(record.body.model, pinnedModel);
    }
    for (const index of [0, 1, 3]) {
      assert.equal(records[index].url, 'https://zenmux.ai/api/anthropic/v1/messages');
      assert.deepEqual(records[index].body.cache_control, { type: 'ephemeral', ttl: '1h' });
      assert.ok(records[index].body.tools.length);
      const system = JSON.stringify(records[index].body.system);
      const tail = JSON.stringify(records[index].body.messages.at(-1));
      for (const label of ['收藏泡泡', '原生闹钟', '应用限制']) assert.ok(system.includes(label));
      for (const removed of ['自主收藏值得留下的真实对话', 'native_alarm_tools', 'food_notebook', 'dream_recall', 'wake_scene_actions']) {
        assert.ok(!tail.includes(removed), removed);
      }
    }
    assert.deepEqual(records[0].body.system, records[1].body.system);
    assert.equal(records[2].url, 'https://zenmux.ai/api/v1/chat/completions');
    const providers = await (await fetch(base + '/v1/providers')).json();
    assert.deepEqual(providers.providers, [{ id: 'zenmux', models: [pinnedModel], configuredModel: pinnedModel }]);
    const usage = await (await fetch(base + '/v1/usage/requests', { headers: authorization })).json();
    assert.ok(usage.requests.some(request => request.provider === 'zenmux' &&
      request.model === pinnedModel && request.cachedTokens === 1024 && request.inputTokens === 2048));

    await stop(child);
    const threadPath = join(dataDir, 'threads.json');
    const threads = JSON.parse(await readFile(threadPath, 'utf8'));
    Object.assign(threads.default.activity, { mode: 'sentinel', nextWakeAt: new Date(Date.now() - 1000).toISOString(), nextWakeSource: 'settings' });
    await writeFile(threadPath, JSON.stringify(threads));
    child = launch('100');
    const restartedPort = await waitForPort(child);
    const restarted = await fetch(`http://127.0.0.1:${restartedPort}/v1/settings/zenmux`, { headers: authorization });
    assert.equal(restarted.status, 200);
    assert.deepEqual(await restarted.json(), { enabled: true, configured: true, model: pinnedModel });
    let wakeRequests;
    for (let attempt = 0; attempt < 60; attempt++) {
      wakeRequests = (await readFile(capture, 'utf8')).trim().split('\n').slice(4).map(line => JSON.parse(line));
      if (wakeRequests.length >= 2) break;
      await delay(50);
    }
    const [wake, continuation] = wakeRequests;
    assert.ok(wake && continuation, 'the autonomous wake and its tool response must both reach the fixture');
    assert.deepEqual(wake.body.tools, records[1].body.tools);
    assert.deepEqual(wake.body.system, records[1].body.system);
    assert.match(wake.body.messages.at(-1).content, /本轮自主唤醒不能调用共享日历/);
    assert.doesNotMatch(wake.body.messages.at(-1).content, /<request_failure/);
    assert.ok(wake.body.messages.slice(0, -1).some(message => String(message.content).includes('模拟上游失败')));
    assert.deepEqual(continuation.body.messages.at(-1).content, [
      { type: 'tool_result', tool_use_id: 'wake-calendar', is_error: true, content: 'MCP 工具不可用' }
    ]);
    let savedWake;
    for (let attempt = 0; attempt < 60; attempt++) {
      savedWake = JSON.parse(await readFile(threadPath, 'utf8')).default.messages.findLast(message => message.contentType === 'sentinel');
      if (savedWake) break;
      await delay(50);
    }
    assert.equal(savedWake?.content, '我在这里。');
    assert.equal(savedWake.modelContent, savedWake.content);
  } finally {
    await stop(child);
    await rm(dataDir, { recursive: true, force: true });
  }
});
