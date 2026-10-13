import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueTakeoutJob, claimTakeoutJob, finishTakeoutJob, markTakeoutAgentSeen, takeoutAgentStatus } from '../src/takeout-bridge.js';

test('takeout job fails fast while the Mac agent is offline', async () => {
  const result = await enqueueTakeoutJob({ cart: true });
  assert.equal(result.ok, false);
  assert.match(result.why, /助手没有连接/);
});

test('cart jobs keep the direct-cart flag and return only the agent result', async () => {
  markTakeoutAgentSeen();
  assert.equal(takeoutAgentStatus().connected, true);
  const pending = enqueueTakeoutJob({ cart: true, dry: true });
  const job = claimTakeoutJob();
  assert.equal(job.input.cart, true);
  assert.equal(job.input.dry, true);
  const result = { ok: true, amount: 18.5, items: ['拿铁 × 1'], address: '桃李春风如山13幢2单元1210' };
  assert.equal(finishTakeoutJob(job.id, result), true);
  assert.equal((await pending).amount, 18.5);
});
