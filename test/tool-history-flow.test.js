import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const listen = async server => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port; };

for (const format of ['anthropic', 'openai']) test(`${format}: actual MCP errors/successes survive restart, challenge and compaction`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-tool-history-'));
  const seen = [];
  let executions = 0, child;
  const tools = [{ name: 'list_repos', description: 'List repositories', inputSchema: { type: 'object', properties: {} } }];
  await writeFile(join(directory, 'mcp-clients.json'), JSON.stringify({ revision: 1, mailEnabled: false,
    servers: [{ id: 'test', name: 'Test MCP', url: 'https://mcp.test/mcp', enabled: true, headers: {}, tools }] }));
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET') return res.end('[]');
    if (req.url.includes('/api/integrations/')) return res.end('{"related":""}');
    const body = JSON.parse(raw);
    if (req.url === '/mcp') {
      let result = {};
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} } };
      if (body.method === 'tools/list') result = { tools };
      if (body.method === 'tools/call') {
        executions++;
        result = { isError: executions === 1, content: [{ type: 'text', text: executions === 1 ? 'Bad credentials' : 'repo-found' }] };
      }
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    }
    const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const main = body.messages?.some(m => m.role === 'user' && textOf(m).includes('<emotion_state'));
    const last = body.messages?.at(-1);
    if (main) seen.push(body);
    const sendText = text => res.end(JSON.stringify(format === 'anthropic'
      ? { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } }
      : { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    if (!main) return sendText('{"events":[]}');
    const results = body.messages.flatMap(m => m.role === 'tool' ? [m] : Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []);
    if (results.length) return sendText('工具结果已返回。');
    const input = textOf(last);
    if (input.includes('执行测试查询')) {
      const name = body.tools.find(t => /list_repos$/.test(t.name || t.function?.name))?.name || body.tools.find(t => /list_repos$/.test(t.function?.name))?.function.name;
      return res.end(JSON.stringify(format === 'anthropic'
        ? { content: [{ type: 'tool_use', id: `c${executions}`, name, input: {} }], stop_reason: 'tool_use' }
        : { choices: [{ message: { content: null, tool_calls: [{ id: `c${executions}`, type: 'function', function: { name, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
    }
    // The test verifies the data actually reaching the provider, not model psychology.
    return sendText(input.includes('<tool_execution_history') ? '服务端保存了实际执行结果。' : '缺少工具记录');
  });
  const providerPort = await listen(provider), probe = createServer();
  const port = await listen(probe); await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  const start = async () => {
    const env = { ...process.env, PORT: String(port), LUMI_DATA_DIR: directory, LUMI_PUSH_API_TOKEN: 'test',
      LUMI_TEST_MODEL_TARGET: `http://127.0.0.1:${providerPort}`, LUMI_MEMORY_API_URL: `http://127.0.0.1:${providerPort}`,
      LUMI_PROMISE_ALARM_ENABLED: 'false', LUMI_CACHE_KEEPALIVE_ENABLED: 'false', LUMI_BACKGROUND_PULSE_MS: '60000' };
    for (const key of ['MURMUR_SERVICE_URL', 'GITHUB_MCP_URL', 'ENGAWA_MCP_URL', 'LETTERS_MAP_PASSWORD']) delete env[key];
    child = spawn(process.execPath, ['--import', new URL('./mock-tool-fetch.js', import.meta.url).pathname, 'src/index.js'], { cwd: new URL('..', import.meta.url), env, stdio: 'ignore' });
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(`backend exited ${child.exitCode}`);
      try { if ((await fetch(base + '/health')).ok) return; } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('backend unavailable');
  };
  const stop = async () => { if (child?.exitCode === null) { const done = new Promise(r => child.once('exit', r)); child.kill(); await done; } child = null; };
  const chat = async content => {
    const result = await fetch(base + '/v1/chats/default/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ content, provider: 'custom', model: 'claude-test', customProvider: { apiKey: 'test', baseURL: 'https://model.test/v1', apiFormat: format } }) });
    assert.equal(result.status, 200, await result.clone().text());
    return (await result.json()).assistantMessage;
  };
  try {
    await start();
    const first = await chat('执行测试查询');
    assert.equal(executions, 1, JSON.stringify({first, seen: seen.map(q => ({tools:q.tools?.map(t=>t.name||t.function?.name),last:q.messages.at(-1)}))}));
    assert.equal(first.toolCalls[0].executed, true);
    assert.equal(first.toolCalls[0].succeeded, false);
    const resultRequest = seen.at(-1);
    if (format === 'anthropic') assert.equal(resultRequest.messages.at(-1).content[0].is_error, true);
    assert.doesNotMatch(first.content, /lumi_tool_calls|tool_execution_history/);
    await stop();
    const path = join(directory, 'threads.json');
    const threads = JSON.parse(await readFile(path, 'utf8'));
    const thread = threads.default;
    thread.contextSummary = '摘要中助手口头否认自己执行过查询。';
    thread.compactedThroughMessageId = first.id;
    thread.cacheKeepaliveMessages = null;
    await writeFile(path, JSON.stringify(threads));
    await start();
    await chat('你刚才根本没调吧？');
    const value = seen.at(-1).messages.at(-1).content;
    const suffix = typeof value === 'string' ? value : value.map(b => b.text || '').join('');
    assert.match(suffix, /<tool_execution_history/);
    assert.match(suffix, /"name":"list_repos","status":"failed"/);
    assert.match(suffix, /Bad credentials/);
    assert.equal(executions, 1, 'questioning the assistant must not repeat the operation');
    const success = await chat('再次执行测试查询');
    assert.equal(executions, 2);
    assert.equal(success.toolCalls[0].succeeded, true);
    await chat('又没调吧？');
    const nextValue = seen.at(-1).messages.at(-1).content;
    const next = typeof nextValue === 'string' ? nextValue : nextValue.map(b => b.text || '').join('');
    assert.match(next, /"name":"list_repos","status":"succeeded"/);
    assert.match(next, /repo-found/);
    assert.equal(executions, 2);
  } finally { await stop(); await new Promise(r => provider.close(r)); await rm(directory, { recursive: true, force: true }); }
});
