import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from 'ssh2';

const port = Number(process.env.PORT || 8788);
const token = String(process.env.MCP_ACCESS_TOKEN || '');
const allowedApps = new Set(String(process.env.COOLIFY_ALLOWED_APP_UUIDS || '').split(',').map(value => value.trim()).filter(Boolean));
const MAX_BODY = 1024 * 1024;
const MAX_OUTPUT = 24_000;

const tools = [
  { name: 'ssh_diagnostics', description: 'Run one fixed, read-only VPS check over a forced-command SSH key. No arbitrary shell, sudo, file edits, or Docker access.', inputSchema: { type: 'object', properties: { check: { type: 'string', enum: ['uptime', 'disk', 'memory', 'failed_services', 'recent_errors'], description: 'The fixed diagnostic to run.' } }, required: ['check'], additionalProperties: false } },
  { name: 'coolify_list_apps', description: 'List the Coolify applications explicitly allowlisted for this MCP server.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'coolify_application_logs', description: 'Read recent runtime logs for an allowlisted Coolify application. Requires a Coolify token with read:sensitive.', inputSchema: { type: 'object', properties: { app_uuid: { type: 'string' }, lines: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }, required: ['app_uuid'], additionalProperties: false } },
  { name: 'coolify_deployment_history', description: 'Read deployment history for an allowlisted Coolify application.', inputSchema: { type: 'object', properties: { app_uuid: { type: 'string' }, take: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }, required: ['app_uuid'], additionalProperties: false } },
  { name: 'coolify_restart_app', description: 'Restart an allowlisted Coolify application. Only call when the user explicitly requested the restart; requires confirmation exactly RESTART <app_uuid>.', inputSchema: { type: 'object', properties: { app_uuid: { type: 'string' }, confirmation: { type: 'string', description: 'Must equal RESTART followed by the exact app UUID.' } }, required: ['app_uuid', 'confirmation'], additionalProperties: false } },
  { name: 'coolify_deploy_app', description: 'Queue a deployment for an allowlisted Coolify application. Only call when the user explicitly requested deployment; requires confirmation exactly DEPLOY <app_uuid>. Force rebuild is off by default.', inputSchema: { type: 'object', properties: { app_uuid: { type: 'string' }, confirmation: { type: 'string', description: 'Must equal DEPLOY followed by the exact app UUID.' }, force: { type: 'boolean', default: false } }, required: ['app_uuid', 'confirmation'], additionalProperties: false } }
];

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: text.slice(0, MAX_OUTPUT) }], ...(isError ? { isError: true } : {}) };
}

function bearerMatches(req) {
  if (!token) return false;
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(supplied); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`服务端尚未配置 ${name}`);
  return value;
}

function permittedApp(uuid) {
  if (!allowedApps.size) throw new Error('服务端未设置 COOLIFY_ALLOWED_APP_UUIDS；默认拒绝所有应用操作');
  if (!allowedApps.has(String(uuid || ''))) throw new Error('该应用 UUID 未加入 COOLIFY_ALLOWED_APP_UUIDS');
  return String(uuid);
}

function coolifyBase() {
  const url = new URL(requireEnv('COOLIFY_API_URL'));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('COOLIFY_API_URL 只填写 Coolify 域名根地址，不要附带路径、凭据或查询参数');
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && !url.hostname.endsWith('.internal')) throw new Error('COOLIFY_API_URL 必须使用 HTTPS（仅允许本机/内部网络使用 HTTP）');
  return url.toString().replace(/\/$/, '');
}

async function coolifyRequest(path, { method = 'GET', query = {}, tokenEnv = 'COOLIFY_READ_API_TOKEN' } = {}) {
  const base = coolifyBase();
  const url = new URL(`${base}/api/v1${path}`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${requireEnv(tokenEnv)}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000), redirect: 'error'
  });
  const body = await response.text();
  let parsed; try { parsed = JSON.parse(body); } catch { parsed = body; }
  if (!response.ok) throw new Error(`Coolify API ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 800)}`);
  return parsed;
}

const diagnosticCommands = Object.freeze({
  uptime: 'lumi-mcp uptime',
  disk: 'lumi-mcp disk',
  memory: 'lumi-mcp memory',
  failed_services: 'lumi-mcp failed_services',
  recent_errors: 'lumi-mcp recent_errors'
});

function sshDiagnostic(check) {
  const command = diagnosticCommands[check];
  if (!command) throw new Error('不支持的只读诊断项');
  const host = requireEnv('SSH_HOST');
  const expectedFingerprint = requireEnv('SSH_HOST_FINGERPRINT').replace(/^SHA256:/, '');
  const privateKey = requireEnv('SSH_PRIVATE_KEY').replace(/\\n/g, '\n');
  const parsedPort = Number(process.env.SSH_PORT || 22);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) throw new Error('SSH_PORT 无效');
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const timer = setTimeout(() => done(new Error('SSH 诊断超时')), 20_000);
    timer.unref();
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      if (error) reject(error); else resolve(String(value || '').slice(0, MAX_OUTPUT));
    };
    conn.on('ready', () => conn.exec(command, { pty: false }, (error, stream) => {
      if (error) return done(error);
      let output = ''; let stderr = '';
      stream.on('data', chunk => { output = (output + chunk.toString()).slice(-MAX_OUTPUT); });
      stream.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT); });
      stream.on('close', code => code === 0 ? done(null, output.trim()) : done(new Error(`SSH 诊断退出码 ${code}: ${(stderr || output).trim().slice(0, 800)}`)));
      stream.on('timeout', () => stream.close());
    }));
    conn.on('error', error => done(new Error(`SSH 连接失败：${error.message}`)));
    conn.connect({
      host, port: parsedPort, username: requireEnv('SSH_USER'), privateKey,
      readyTimeout: 10_000, keepaliveInterval: 5_000, keepaliveCountMax: 2,
      hostHash: 'sha256', hostVerifier: fingerprint => fingerprint === expectedFingerprint
    });
  });
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'ssh_diagnostics': return textResult(await sshDiagnostic(args.check));
    case 'coolify_list_apps': {
      const apps = await coolifyRequest('/applications');
      const rows = Array.isArray(apps) ? apps : [];
      return textResult(rows.filter(app => allowedApps.has(String(app.uuid))).map(app => ({ uuid: app.uuid, name: app.name, status: app.status, fqdn: app.fqdn })));
    }
    case 'coolify_application_logs': {
      const uuid = permittedApp(args.app_uuid);
      const logs = await coolifyRequest(`/applications/${encodeURIComponent(uuid)}/logs`, { query: { lines: Math.min(500, Math.max(1, Number(args.lines) || 100)), show_timestamps: true } });
      return textResult(logs);
    }
    case 'coolify_deployment_history': {
      const uuid = permittedApp(args.app_uuid);
      const rows = await coolifyRequest(`/deployments/applications/${encodeURIComponent(uuid)}`, { query: { take: Math.min(50, Math.max(1, Number(args.take) || 10)) } });
      return textResult(rows);
    }
    case 'coolify_restart_app': {
      const uuid = permittedApp(args.app_uuid);
      if (args.confirmation !== `RESTART ${uuid}`) throw new Error(`需要明确确认：confirmation 必须为 RESTART ${uuid}`);
      return textResult(await coolifyRequest(`/applications/${encodeURIComponent(uuid)}/restart`, { method: 'POST', tokenEnv: 'COOLIFY_DEPLOY_API_TOKEN' }));
    }
    case 'coolify_deploy_app': {
      const uuid = permittedApp(args.app_uuid);
      if (args.confirmation !== `DEPLOY ${uuid}`) throw new Error(`需要明确确认：confirmation 必须为 DEPLOY ${uuid}`);
      const result = await coolifyRequest('/deploy', { method: 'POST', tokenEnv: 'COOLIFY_DEPLOY_API_TOKEN', query: { uuid, force: args.force === true } });
      return textResult(result);
    }
    default: throw new Error('MCP 工具不存在');
  }
}

async function readJSON(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > MAX_BODY) throw new Error('请求体过大');
  }
  return JSON.parse(raw || '{}');
}

async function handle(req, res) {
  if (req.method !== 'POST' || req.url?.split('?')[0] !== '/mcp') {
    res.writeHead(req.method === 'GET' && req.url?.split('?')[0] === '/mcp' ? 405 : 404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not_found' }));
  }
  if (!bearerMatches(req)) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }
  let message;
  try { message = await readJSON(req); }
  catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message || 'Invalid JSON' } }));
  }
  if (message.method?.startsWith('notifications/')) { res.writeHead(202); return res.end(); }
  let result;
  try {
    switch (message.method) {
      case 'initialize': result = { protocolVersion: message.params?.protocolVersion === '2025-03-26' ? '2025-03-26' : '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'lumi-vps-coolify', version: '1.0.0' } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools }; break;
      case 'tools/call': result = await callTool(message.params?.name, message.params?.arguments || {}); break;
      default: throw Object.assign(new Error(`Unknown method: ${message.method}`), { code: -32601 });
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result }));
  } catch (error) {
    const isToolCall = message.method === 'tools/call';
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: message.id ?? null,
      ...(isToolCall ? { result: textResult(error.message || 'Tool failed', true) } : { error: { code: error.code || -32603, message: error.message || 'Internal error' } })
    }));
  }
}

if (!token) throw new Error('MCP_ACCESS_TOKEN is required');
if (!process.env.COOLIFY_ALLOWED_APP_UUIDS) console.warn('COOLIFY_ALLOWED_APP_UUIDS is empty; all Coolify application operations will be denied.');
const server = createServer((req, res) => { void handle(req, res).catch(error => { console.error(error); if (!res.headersSent) res.writeHead(500); res.end(); }); });
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(port, '0.0.0.0', () => console.log(`Lumi VPS MCP listening on ${port}`));
