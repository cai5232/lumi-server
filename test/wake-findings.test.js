import assert from "node:assert/strict";
import { test } from "node:test";
import { wakeFindingFilter } from "../src/wake-findings.js";

const oldPoem = "我去檐廊逛了一圈，看到首诗，白居易写牡丹的，“花开花落二十日，一城之人皆若狂”。";
const newPoem = "我去檐廊逛了一圈，读到首诗，《登鹳雀楼》。";
const dailyPoem = { name: "daily_poem", succeeded: true };
const history = [{ role: "assistant", contentType: "sentinel", content: oldPoem }];

test("a wake keeps its check-in and drops a poem it did not read this round", () => {
  const checkIn = "刚想起你。";
  for (const calls of [[], [{ ...dailyPoem, succeeded: false }], [{ name: "list_calendar_events", succeeded: true }]]) {
    const filter = wakeFindingFilter(history, calls);
    assert.equal(filter(`${checkIn}\n\n${oldPoem}`), checkIn);
    assert.equal(filter(newPoem), "");
    assert.equal(filter("我想起一首诗。"), "我想起一首诗。");
  }
});

test("a successful poem lookup permits fresh findings and suppresses earlier quotations", () => {
  const filter = wakeFindingFilter(history, [dailyPoem]);
  assert.equal(filter(newPoem), newPoem);
  assert.equal(filter('又读到白居易的诗，"花开花落二十日，一城之人皆若狂"。'), "");
});
