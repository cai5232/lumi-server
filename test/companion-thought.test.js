import assert from "node:assert/strict";
import { test } from "node:test";
import { readCompanionThought, stripLegacyThoughtPrompt } from "../src/companion-thought.js";

test("character thoughts separate from visible text, private reasoning and code examples", () => {
  assert.deepEqual(readCompanionThought("<think>PRIVATE</think>[[思考：我还记得那个雨天。]]\n我看见了。"), {
    text: "我还记得那个雨天。", content: "<think>PRIVATE</think>\n我看见了。"
  });
  assert.deepEqual(readCompanionThought("<companion_thought>想说谢谢。</companion_thought>谢谢。"), { text: "想说谢谢。", content: "谢谢。" });
  assert.deepEqual(readCompanionThought("正文\n[[思考：半个标记"), { text: null, content: "正文" });
  const code = "```txt\n[[思考：语法举例]]\n```";
  assert.deepEqual(readCompanionThought(code), { text: null, content: code });
});

test("a full-length monologue survives extraction without changing the reply", () => {
  const monologue = ["这一句话在我心里停了一会儿。".repeat(21), "我想起我刚才看见窗外下雨。".repeat(21), "我本来想把那句还给她，后来改了主意。".repeat(21)].join("\n\n");
  assert.ok(monologue.length >= 800);
  assert.deepEqual(readCompanionThought(`[[思考：${monologue}]]\n我在听。`), {
    text: monologue, content: "我在听。"
  });
});

test("stored request history drops the old internal directive only at the end", () => {
  const posted = "用户说：保留这个标签 <character_voice>示例</character_voice>";
  const old = "<character_voice>\n## 我脑子转起来的样子\n\n旧指令\n</character_voice>";
  assert.equal(stripLegacyThoughtPrompt(posted + "\n" + old), posted);
  assert.equal(stripLegacyThoughtPrompt(posted), posted);
});
