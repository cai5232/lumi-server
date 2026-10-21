import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const listen = async (server) => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };
for (const remote of [false, true]) {
  for (const enabled of [false, true]) {
    test(`circadian state API: ${remote ? 'Murmur' : 'local'}, enabled=${enabled}`, async () => {
      const folder = await mkdtemp(join(tmpdir(), 'lumi-circadian-'));
      const upstreamState = { drives: { curiosity: { v: .25, z: '好奇', b: .25 }, stress: { v: .3, z: '压力', b: .3 } }, top: { drive: 'stress', value: .3 }, extra: 'preserved' };
      const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(upstreamState)); });
      const upstreamPort = await listen(upstream);
      const probe = createServer();
      const port = await listen(probe);
      await new Promise(resolve => probe.close(resolve));
      const env = { ...process.env, PORT: String(port), LUMI_DATA_DIR: folder,
        LUMI_CIRCADIAN_ENABLED: String(enabled), LUMI_CIRCADIAN_TIME_ZONE: 'UTC',
        LUMI_PUSH_API_TOKEN: 'test-only', LUMI_BACKGROUND_PULSE_MS: '60000', LUMI_PROMISE_ALARM_ENABLED: 'false', LUMI_CACHE_KEEPALIVE_ENABLED: 'false' };
      delete env.MURMUR_SERVICE_URL;
      if (remote) env.MURMUR_SERVICE_URL = `http://127.0.0.1:${upstreamPort}`;
      const child = spawn(process.execPath, ['src/index.js'], { cwd: new URL('..', import.meta.url), env, stdio: 'ignore' });
      const base = `http://127.0.0.1:${port}`;
      try {
        let ready = false;
        for (let i = 0; i < 150; i++) {
          if (child.exitCode !== null) throw new Error(`backend exited ${child.exitCode}`);
          try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(ready, 'backend ready');
        const url = `${base}/v1/chats/default/emotion/state`;
        assert.equal((await fetch(url)).status, 401);
        const headers = { authorization: 'Bearer test-only' };
        const payload = await (await fetch(url, { headers })).json();
        assert.equal(payload.circadian.enabled, enabled);
        assert.equal(payload.circadian.time_zone, 'UTC');
        assert.equal(payload.circadian.cap, .08);
        for (const [key, item] of Object.entries(payload.drives)) {
          const offset = payload.circadian.offsets[key];
          assert.ok(Math.abs(offset) <= .08);
          assert.equal(payload.drive_display[key].v, Math.max(0, Math.min(1, item.v + offset)));
        }
        if (!enabled) assert.equal(JSON.stringify(payload.drives), JSON.stringify(payload.drive_display));
        if (remote) {
          const { drive_display, circadian, ...legacy } = payload;
          assert.deepEqual(legacy, upstreamState);
        } else {
          for (let i = 0; i < 3; i++) await fetch(url, { headers });
          const saved = JSON.parse(await readFile(join(folder, 'emotion-state.json'), 'utf8'));
          assert.equal(saved.drives.curiosity, .25);
          assert.equal(saved.drive_display, undefined);
          assert.equal(saved.circadian, undefined);
        }
        const health = await (await fetch(`${base}/health`)).json();
        assert.equal(health.emotion.circadian.version, 'readonly-v1');
      } finally {
        if (child.exitCode === null) {
          const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit;
        }
        await new Promise(resolve => upstream.close(resolve));
        await rm(folder, { recursive: true, force: true });
      }
    });
  }
}
