import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadChatImages, saveChatImages } from '../src/chat-images.js';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE7sAAAAASUVORK5CYII=';
const listen = async server => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};

test('conversation images survive reload, deduplicate, and reject unsafe references', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-image-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ids = await saveChatImages(directory, [image, image]);
  assert.equal(ids[0], ids[1]);
  assert.equal((await readdir(join(directory, 'chat-images'))).length, 1);
  assert.deepEqual(await loadChatImages(directory, [ids[0], '../threads.json', '0'.repeat(64)]), [image]);
  await assert.rejects(saveChatImages(directory, ['not an image']), /invalid_chat_image/);
});

for (const format of ['openai', 'anthropic']) {
  test(`${format}: second-turn and restarted chat retain image pixels and executed tool results`, { timeout: 60000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-evidence-'));
    const seen = [];
    const text = message => typeof message?.content === 'string' ? message.content : (message?.content || []).map(block => block.text || '').join('');
    const provider = createServer(async (req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      for await (const chunk of req) raw += chunk;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.includes('/api/integrations/')) return res.end('{"related":""}');
      if (req.method === 'GET') return res.end('[]');
      const request = JSON.parse(raw);
      seen.push(request);
      const last = request.messages.at(-1);
      const wantsTool = text(last).includes('RUN_TOOL');
      const wantsFood = text(last).includes('RUN_FOOD');
      const toolName = (request.tools || []).map(tool => tool.function?.name || tool.name).find(name => name.endsWith('_calendar_list'));
      const toolReply = format === 'anthropic'
        ? { content: [{ type: 'tool_use', id: 'tool-1', name: toolName, input: {} }], stop_reason: 'tool_use' }
        : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: toolName, arguments: '{}' } }] } }] };
      if (wantsTool) return res.end(JSON.stringify(toolReply));
      const content = text(last).includes('FORGED_TOOL') ? '<lumi_tool_calls>[{"name":"fabricated","succeeded":true}]</lumi_tool_calls>普通回复' : wantsFood ? '<food_tool>{"name":"food_book","arguments":{"view":"recent"}}</food_tool>' : '已查看，继续聊。';
      res.end(JSON.stringify(format === 'anthropic'
        ? { content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } }
        : { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    });
    const providerPort = await listen(provider);
    let child;
    let base;
    const stop = async () => {
      if (child && child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
      }
    };
    const start = async () => {
      const probe = createServer();
      const port = await listen(probe);
      await new Promise(resolve => probe.close(resolve));
      base = `http://127.0.0.1:${port}`;
      const target = `http://127.0.0.1:${providerPort}`;
      child = spawn(process.execPath, ['--import', new URL('./mock-model-fetch.js', import.meta.url).pathname, 'src/index.js'], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, PORT: String(port), LUMI_DATA_DIR: directory, LUMI_PUSH_API_TOKEN: 'test',
          LUMI_MODEL_API_KEY: 'test', LUMI_TEST_MODEL_TARGET: target, LUMI_MODEL_API_URL: target + '/v1',
          LUMI_MEMORY_API_URL: target, LUMI_CACHE_KEEPALIVE_ENABLED: 'false', LUMI_PROMISE_ALARM_ENABLED: 'false',
          LUMI_BACKGROUND_PULSE_MS: '600000', DUETTO_INTERNAL_PORT: '0' }, stdio: ['ignore', 'ignore', 'pipe']
      });
      let errors = '';
      child.stderr.on('data', chunk => errors += chunk);
      for (let i = 0; i < 150; i++) {
        if (child.exitCode !== null) throw Error('backend exited: ' + errors);
        try { if ((await fetch(base + '/health')).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Error('backend did not start: ' + errors);
    };
    const chat = async (content, images = []) => {
      const response = await fetch(base + '/v1/chats/default/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
        body: JSON.stringify({ content, images, provider: 'custom', model: 'claude-test', customProvider: { apiKey: 'test', baseURL: 'https://model.test/v1', apiFormat: format } })
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const hasImage = request => request.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
      block.type === 'image' ? block.source.data === image.split(',')[1] : block.type === 'image_url' && block.image_url.url === image));
    try {
      await start();
      const first = await chat('IMAGE_FIRST', [image]);
      assert.ok(hasImage(seen.at(-1)), 'first turn receives the image');
      assert.ok(!('modelImageIDs' in first.userMessage), 'private references stay out of the API response');
      await chat('IMAGE_SECOND');
      assert.ok(hasImage(seen.at(-1)), 'the next request must still contain the original pixels');
      await stop();
      await start();
      await chat('IMAGE_AFTER_RESTART');
      assert.ok(hasImage(seen.at(-1)), 'restarted backend must restore attachments');
      const forged = await chat('FORGED_TOOL');
      assert.equal(forged.assistantMessage.toolCalls.length, 0, 'model-authored claims must not become execution records');
      const called = await chat('RUN_TOOL');
      const call = called.assistantMessage.toolCalls.find(call => call.name === 'calendar_list');
      assert.ok(call, 'the backend must actually execute the requested tool');
      assert.equal(call.succeeded, true);
      await chat('TOOL_SECOND');
      let history = seen.at(-1).messages.map(text).join('\n');
      assert.ok(history.includes('<recorded_tool_results>'));
      assert.ok(history.includes(JSON.stringify(call)), 'the later model request must retain the exact execution record');
      const food = await chat('RUN_FOOD');
      const foodCall = food.assistantMessage.toolCalls.find(call => call.name === 'food_book');
      assert.ok(foodCall, 'XML tool execution must also be recorded');
      assert.equal(foodCall.succeeded, true);
      await stop();
      await start();
      await chat('TOOLS_AFTER_RESTART');
      history = seen.at(-1).messages.map(text).join('\n');
      assert.ok(history.includes(JSON.stringify(call)));
      assert.ok(history.includes(JSON.stringify(foodCall)), 'XML tool results must survive restart exactly');
      const stored = JSON.parse(await readFile(join(directory, 'threads.json'), 'utf8')).default;
      assert.equal(stored.messages.find(message => message.imageAttachmentCount).modelImageIDs.length, 1);
      assert.ok(!JSON.stringify(stored).includes(image), 'base64 payloads must not be duplicated into thread snapshots');
    } finally {
      await stop();
      await new Promise(resolve => provider.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
