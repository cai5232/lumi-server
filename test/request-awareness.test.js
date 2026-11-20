import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RequestFailureStore } from "../src/request-awareness.js";

test("keep the most recent distinct sends prominent and surface quoted older messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lumi-request-awareness-"));
  try {
    const store = new RequestFailureStore(join(directory, "failures.json"));
    const threadId = "default";
    const now = Date.UTC(2026, 10, 20, 6);
    const older = Array.from({ length: 45 }, (_, i) => {
      const at = new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
      return { threadId, requestId: "old-" + i, source: "server", message: "较早发送的消息 " + i,
        error: "连接失败", requestedAt: at, failedAt: at };
    });
    await store.recordAll(older);
    await store.acknowledge(threadId, (await store.read()).map(event => event.id));
    await store.recordAll([
      { threadId, requestId: "send-a", source: "server", message: "第一次没发成", error: "服务端 502",
        requestedAt: "2026-11-20T05:34:10Z", failedAt: "2026-11-20T05:36:00Z" },
      { threadId, requestId: "send-a", source: "client", message: "第一次没发成", error: "手机提示生成失败",
        requestedAt: "2026-11-20T05:34:10Z", failedAt: "2026-11-20T05:36:00Z" },
      { threadId, requestId: "send-b", source: "server", message: "第二次没发成", error: "线路超时",
        requestedAt: "2026-11-20T05:35:14Z", failedAt: "2026-11-20T05:35:14Z" }
    ]);
    const regular = await store.timeline(threadId, null, { userInput: "接着说", now });
    assert.equal(regular.length, 2);
    assert.match(regular[0].content, /第一次没发成.*服务端 502.*手机提示生成失败/);
    assert.match(regular[1].content, /第二次没发成/);
    assert.equal(regular[0].ids.length, 2);
    const question = await store.timeline(threadId, null, { userInput: "「较早发送的消息 0」是什么报错？", now });
    assert.match(question[0].content, /较早发送的消息 0/);
    assert.match(question.at(-1).content, /第二次没发成/);
    assert.deepEqual(await store.timeline(threadId, "2026-11-20T05:40:00Z", { now }), []);
    const archived = await store.read();
    assert.equal(archived.length, 48);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
