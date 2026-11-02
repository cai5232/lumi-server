import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppControlStore } from '../src/app-control.js';
test('new apps can be added, expiring restrictions and emergency clearing work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lumi-app-control-')); let now = 100000;
  try {
    const store = createAppControlStore(dir, () => now);
    await store.configure({ apps: ['抖音', '小红书'] });
    await store.set({ app: '其他', blocked: true });
    assert.ok((await store.get()).apps.includes('其他'));
    await store.clear();
    await assert.rejects(store.set({ app: '抖音', blocked: true }, { autonomous: true }), /autonomous_control_disabled/);
    await store.configure({ apps: ['抖音', '小红书'], autonomous: true });
    await store.set({ app: '小红书', blocked: true }, { autonomous: true });
    assert.equal((await store.check('小红书')).blocked, true);
    await store.clear();
    await store.set({ app: '抖音', blocked: true, minutes: 5 });
    assert.deepEqual(await store.check('抖音'), { blocked: true });
    now += 300001;
    assert.deepEqual(await store.check('抖音'), { blocked: false });
    await store.set({ app: '小红书', blocked: true });
    await store.clear();
    assert.deepEqual((await store.get()).blocked, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
