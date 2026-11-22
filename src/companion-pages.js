import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

const definitions = {
  'night-ferry': { origin: 'http://lumi-night-ferry:3210', tokenKey: 'LUMI_NIGHT_FERRY_MCP_TOKEN', entry: '' },
  kitchenette: { origin: 'http://lumi-kitchenette:8765', tokenKey: 'LUMI_KITCHENETTE_MCP_TOKEN', entry: 'page/' },
};
export function createCompanionPages({ authorized, env = process.env, fetchImpl = fetch, now = Date.now }) {
  const secret = randomBytes(32);
  const sign = (id, value) => createHmac('sha256', secret).update(id + ':' + value).digest('base64url');
  const valid = (id, value) => {
    const [expiry, nonce, signature = ''] = String(value || '').split('.');
    if (!nonce || !/^\d+$/.test(expiry) || Number(expiry) <= now()) return false;
    const expected = Buffer.from(sign(id, expiry + '.' + nonce)), actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };
  return async (req, res, url) => {
    const match = url.pathname.match(/^\/v1\/companions\/([^/]+)\/(.*)$/);
    if (!match || !definitions[match[1]]) { res.writeHead(404); res.end(); return; }
    const [, id, relative] = match, definition = definitions[id], prefix = `/v1/companions/${id}/`;
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (!env[definition.tokenKey]) return reply(503, { error: 'companion_unavailable' });
    if (relative === 'session') {
      if (req.method !== 'POST' || !authorized(req)) return reply(401, { error: 'unauthorized' });
      const value = String(now() + 2 * 60 * 60_000) + '.' + randomBytes(24).toString('base64url');
      res.setHeader('set-cookie', `lumi_companion=${value}.${sign(id, value)}; Path=${prefix}; Max-Age=7200; HttpOnly; Secure; SameSite=Strict`);
      return reply(200, { path: prefix + definition.entry });
    }
    const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('lumi_companion='))?.slice(15);
    if (!valid(id, cookie)) return reply(401, { error: 'companion_session_expired' });
    if (!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(req.method)) return reply(405, { error: 'method_not_allowed' });
    if (req.headers.origin && req.headers.origin !== new URL(env.LUMI_PUBLIC_BASE_URL || 'https://' + url.host).origin) return reply(403, { error: 'origin_not_allowed' });
    if (relative === 'mcp' || relative.startsWith('mcp/')) return reply(404, { error: 'not_found' });
    const target = new URL('/' + relative + url.search, definition.origin);
    if (target.origin !== definition.origin) return reply(400, { error: 'invalid_path' });
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) return reply(413, { error: 'body_too_large' }); chunks.push(chunk); }
      body = Buffer.concat(chunks);
    }
    let upstream;
    try {
      upstream = await fetchImpl(target, { method: req.method, body, headers: {
        authorization: `Bearer ${env[definition.tokenKey]}`,
        ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
      }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    } catch { return reply(502, { error: 'companion_unreachable' }); }
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
    if (upstream.headers.get('location')) {
      const location = new URL(upstream.headers.get('location'), target);
      if (location.origin !== definition.origin) return reply(502, { error: 'unexpected_redirect' });
      headers.location = prefix + location.pathname.slice(1) + location.search;
    }
    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD' || [204,304].includes(upstream.status)) return res.end();
    if (/text\/|javascript|json|xml/.test(type)) {
      let text = await upstream.text();
      // Upstream pages assume an origin root; keep their resources and API calls inside this authenticated mount.
      text = text.replace(/(["'(])\/(api|page|assets|fonts)(?=[/"')])/g, `$1${prefix}$2`);
      if (type.includes('text/html')) {
        const script = `<script>(()=>{const p=${JSON.stringify(prefix)},f=window.fetch;window.fetch=function(input,init){const raw=typeof input==='string'?input:input instanceof URL?input.href:input.url;const u=new URL(raw,location.href);if(u.origin===location.origin&&!u.pathname.startsWith(p)&&/^\\/(api|page|assets|fonts)(\\/|$)/.test(u.pathname)){u.pathname=p+u.pathname.slice(1);input=input instanceof Request?new Request(u.href,input):u.href;}return f.call(this,input,init);};})();</script>`;
        text = text.replace(/<head([^>]*)>/i, `<head$1>${script}`);
      }
      return res.end(text);
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  };
}
