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
    const older = Array.from({ length: 45 }, (_, i) => ({
      threadId, requestId: "old-" + i, source: "server", message: "较早发送的消息 " + i,
      error: "连接失败", failedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()
    }));
    await store.recordAll(older);
    await store.acknowledge(threadId, (await store.read()).map(event => event.id));
    await store.recordAll([
      { threadId, requestId: "send-a", source: "server", message: "第一次没发成", error: "服务端 502", failedAt: "2026-11-20T05:34:49.556Z" },
      { threadId, requestId: "send-a", source: "client", message: "第一次没发成", error: "手机提示生成失败", failedAt: "2026-11-20T05:34:49.000Z" },
      { threadId, requestId: "send-b", source: "server", message: "第二次没发成", error: "线路超时", failedAt: "2026-11-20T05:35:14.724Z" }
    ]);
    const regular = await store.context(threadId, null, { userInput: "接着说" });
    assert.equal((regular.content.match(/^\{/gm) || []).length, 6);
    assert.equal((regular.content.match(/第一次没发成/g) || []).length, 1);
    assert.ok(regular.content.indexOf("第二次没发成") < regular.content.indexOf("第一次没发成"));
    assert.match(regular.content, /服务端 502.*手机提示生成失败/);
    assert.equal(regular.ids.length, 3);
    const question = await store.context(threadId, null, { userInput: "「较早发送的消息 0」是什么报错？" });
    assert.match(question.content, /有对应记录时，直接回应/);
    assert.match(question.content.split("\n").find(line => line.startsWith("{")), /较早发送的消息 0/);
    assert.ok(question.content.includes("第二次没发成"));
    const archived = await store.read();
    assert.equal(archived.length, 48);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
