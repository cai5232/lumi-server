import assert from "node:assert/strict";
import { test } from "node:test";
import { readCompanionThought } from "../src/companion-thought.js";

test("character thoughts separate from visible text, private reasoning and code examples", () => {
  assert.deepEqual(readCompanionThought("<think>PRIVATE</think>[[思考：我还记得那个雨天。]]\n我看见了。"), {
    text: "我还记得那个雨天。", content: "<think>PRIVATE</think>\n我看见了。"
  });
  assert.deepEqual(readCompanionThought("<companion_thought>想说谢谢。</companion_thought>谢谢。"), { text: "想说谢谢。", content: "谢谢。" });
  assert.deepEqual(readCompanionThought("正文\n[[思考：半个标记"), { text: null, content: "正文" });
  const code = "```txt\n[[思考：语法举例]]\n```";
  assert.deepEqual(readCompanionThought(code), { text: null, content: code });
});
