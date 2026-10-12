import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_SERVERS = 30;
const privateHost = host => host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal' || /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === '::1' || /^(fc|fd|fe80:)/i.test(host);

export function validateMcpURL(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('MCP URL 无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || privateHost(url.hostname.toLowerCase())) throw new Error('MCP 服务器必须使用公开 HTTPS 地址');
  return url.toString();
}

export function normalizeMcpServers(input) {
  if (!Array.isArray(input) || input.length > MAX_SERVERS) throw new Error(`MCP 服务器最多 ${MAX_SERVERS} 个`);
  const ids = new Set();
  return input.map(item => {
    if (!item || typeof item !== 'object') throw new Error('MCP 服务器格式无效');
    const id = String(item.id || randomUUID());
    if (id === 'lumi-email') throw new Error('此 ID 为内置邮箱 MCP 保留');
    if (ids.has(id)) throw new Error('MCP 服务器 ID 重复');
    ids.add(id);
    const headers = {};
    for (const [key, value] of Object.entries(item.headers || {})) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(key) || /^(host|content-length|connection|transfer-encoding)$/i.test(key)) throw new Error('MCP 请求头名称无效');
      headers[key] = String(value).slice(0, 4000);
    }
    return { id, name: String(item.name || 'MCP 服务器').trim().slice(0, 100) || 'MCP 服务器', enabled: item.enabled !== false, url: validateMcpURL(item.url), headers, tools: Array.isArray(item.tools) ? item.tools.slice(0, 300) : [], connectedAt: item.connectedAt || null, error: '' };
  });
}

export class McpClientStore {
  constructor(path) { this.path = path; this.queue = Promise.resolve(); }
  async read() {
    let settings;
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      settings = { ...value, servers: Array.isArray(value.servers) ? value.servers : [], revision: Number(value.revision || 0), mailEnabled: value.mailEnabled !== false };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      settings = { servers: [], revision: 0, mailEnabled: true };
    }
    const mapPassword = process.env.LETTERS_MAP_PASSWORD;
    if (mapPassword && !settings.servers.some(server => server.id === 'letters-map')) {
      const baseURL = (process.env.LETTERS_MAP_BASE_URL || 'https://lumi-hidden-letters.zeabur.app').replace(/\/$/, '');
      settings.servers.push(normalizeMcpServers([{
        id: 'letters-map', name: '藏宝地图', enabled: true, url: `${baseURL}/mcp`,
        headers: { Authorization: `Bearer ${mapPassword}` }, tools: [], connectedAt: null
      }])[0]);
    }
    const neteaseMcpURL = process.env.LUMI_NETEASE_MCP_URL;
    const neteaseMcpToken = process.env.LUMI_NETEASE_MCP_TOKEN;
    if (neteaseMcpURL && neteaseMcpToken && !settings.servers.some(server => server.id === 'netease-music')) {
      settings.servers.push(normalizeMcpServers([{
        id: 'netease-music', name: '网易云音乐', enabled: true, url: neteaseMcpURL,
        headers: { Authorization: `Bearer ${neteaseMcpToken}` }, tools: [], connectedAt: null
      }])[0]);
    }
    return settings;
  }
  async save(input) {
    const action = this.queue.then(async () => {
      const current = await this.read();
      const servers = normalizeMcpServers(input.servers);
      const next = { servers, revision: current.revision + 1, mailEnabled: current.mailEnabled !== false };
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2)); await rename(temporary, this.path);
      return next;
    });
    this.queue = action.catch(() => {}); return action;
  }
  async setMailEnabled(enabled) {
    const action = this.queue.then(async () => {
      const current = await this.read();
      const next = { ...current, servers: current.servers, revision: current.revision + 1, mailEnabled: enabled === true };
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2)); await rename(temporary, this.path);
      return next;
    });
    this.queue = action.catch(() => {}); return action;
  }
}

function readMcpPayload(text, contentType = '') {
  if (contentType.includes('text/event-stream')) {
    const events = text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')).filter(Boolean);
    const json = events.reverse().find(value => { try { return JSON.parse(value)?.jsonrpc === '2.0'; } catch { return false; } });
    return json ? JSON.parse(json) : {};
  }
  try { return JSON.parse(text); } catch { return {}; }
}

export async function mcpRequest(server, method, params = {}, session = null) {
  const id = randomUUID();
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...server.headers, ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(20_000), redirect: 'error'
  });
  const sessionId = response.headers.get('mcp-session-id') || session;
  const payload = readMcpPayload(await response.text(), response.headers.get('content-type') || '');
  if (!response.ok) throw new Error(payload?.error?.message || `MCP 服务器返回 ${response.status}`);
  if (payload.error) throw new Error(String(payload.error.message || 'MCP 请求失败'));
  return { result: payload.result || {}, sessionId };
}

export async function connectMcpServer(server) {
  const protocolVersion = '2025-03-26';
  const initialized = await mcpRequest(server, 'initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'Lumi', version: '1.0' } });
  if (initialized.sessionId) {
    await fetch(server.url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...server.headers, 'mcp-session-id': initialized.sessionId }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
  }
  const listed = await mcpRequest(server, 'tools/list', {}, initialized.sessionId);
  return { tools: Array.isArray(listed.result.tools) ? listed.result.tools : [], sessionId: listed.sessionId, serverInfo: initialized.result.serverInfo || null };
}

export async function callMcpTool(server, name, args) {
  const connection = await connectMcpServer(server);
  if (!connection.tools.some(tool => tool.name === name)) throw new Error('MCP 工具不存在或尚未启用');
  const called = await mcpRequest(server, 'tools/call', { name, arguments: args }, connection.sessionId);
  return called.result;
}
