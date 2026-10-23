import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstantCommandStore, parseInstantCommands, commandFeedbackText } from '../src/instant-commands.js';

test('countdown parser hides private and incomplete tags and validates timing', () => {
  const result = parseInstantCommands('喝点水<countdown>{"title":"喝水","minutes":1.5}</countdown><countdown>{"title":"整理桌面"}</countdown><countdown>{"title":"坏值","minutes":-2}</countdown><countdown>broken');
  assert.equal(result.content, '喝点水');
  assert.deepEqual(result.items, [{ title: '喝水', countdown_seconds: 90 }, { title: '整理桌面', countdown_seconds: null }]);
  assert.equal(parseInstantCommands('<countdown>{"title":"长任务","minutes":9999}</countdown>').items[0].countdown_seconds, 86400);
});

test('persistent timers are thread scoped; completion is atomic and feedback acknowledgements preserve concurrent results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-commands-'));
  let now = 100000;
  try {
    const store = createInstantCommandStore(directory, () => now);
    const [command] = await store.add('a', [{ title: '喝水', countdown_seconds: 60 }]);
    assert.deepEqual(await store.add('a', [{ title: '喝水', countdown_seconds: 60 }]), []);
    assert.equal((await store.add('b', [{ title: '喝水', countdown_seconds: 60 }])).length, 1);
    now += 75000;
    assert.equal((await store.act('a', command.id, 'started')).started_at, 100000);
    assert.equal(await store.act('b', command.id, 'complete'), null);
    const results = await Promise.all([store.act('a', command.id, 'complete'), store.act('a', command.id, 'complete')]);
    assert.equal(results.filter(Boolean).length, 1);
    const snapshot = await store.feedback('a');
    assert.equal(snapshot[0].duration_ms, 75000);
    assert.match(commandFeedbackText(snapshot), /超出 15 秒/);
    const [next] = await store.add('a', [{ title: '叠被子', countdown_seconds: null }]);
    await store.act('a', next.id, 'complete');
    // A failed model request leaves the same feedback available on retry.
    assert.equal((await store.feedback('a')).length, 2);
    await store.acknowledge('a', snapshot.map(item => item.id));
    const reopened = createInstantCommandStore(directory, () => now);
    assert.equal((await reopened.feedback('a')).length, 1);
    assert.equal((await reopened.list('b')).length, 1);
    const [cancelled] = await reopened.add('a', [{ title: '取消我', countdown_seconds: 10 }]);
    await reopened.act('a', cancelled.id, 'cancel');
    assert.equal((await reopened.feedback('a')).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
