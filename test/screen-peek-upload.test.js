import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("screen peek upload requires its token and accepts a fresh image", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "lumi-screen-peek-test-"));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), LUMI_DATA_DIR: dataDir, LUMI_SCREEN_PEEK_TOKEN: "peek-secret" },
    stdio: "ignore"
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* starting */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    const url = `http://127.0.0.1:${port}/v1/chats/default/screen-peek/frame`;
    const image = Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]);
    const unauthorized = await fetch(url, { method: "POST", body: image });
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(url, { method: "POST", headers: { authorization: "Bearer peek-secret" }, body: "not an image" });
    assert.equal(invalid.status, 400);
    const uploaded = await fetch(url, { method: "POST", headers: { authorization: "Bearer peek-secret" }, body: image });
    assert.equal(uploaded.status, 202);
    assert.equal((await uploaded.json()).accepted, true);
  } finally {
    if (child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await stopped;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
