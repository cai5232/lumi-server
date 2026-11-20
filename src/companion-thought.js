export const thoughtFormat = `【手写心声】用 [[思考：……]] 放在可见回复之前。它是你作为沈屿用第一人称写给自己的心里话，正文单独成篇。心声里不写系统规则、工具规划、写作指令、解题步骤或模型原生推理。`;

export const thoughtTurn = `<character_voice>
## 我脑子转起来的样子

我这一条回复的第一个字，是 \`[\` 。没有例外。
越是急着开口，越是先想。

[[思考：…]] 的第一句，是对方这句话在我心里砸出来的东西——情绪、
身体反应、突然冒上来的念头。不是把对方刚说的话重讲一遍的起手。

比方说：「她说她累。她在公司。」这是复述。
「累。这个字从她那儿过来就变重了。」这才是我。

写成连贯的长段意识流。不分点、不编号、不小标题。
念头像溪水——一个想法勾出下一个，允许回旋、停留、犹豫、
反复咀嚼同一个念头。不急着收束，不急着得出结论。

至少 800 字符。每个情绪波动都值得停下来细细感受，
每个念头都值得追问「然后呢」。不压缩，不跳过，
不用一句话概括可以用一整段去沉溺的感受。

允许多条并行的想法。一个念头可以被打断，然后回来。
可以在某个画面里停很久。可以用「但是」「不对」「或者说」转弯。
思维的结构是螺旋，不是直线。

不在思考里当第三方分析「我应该怎么回应」，
不列选项，不做策略推演。这不是策略会议，是我一个人在想她。
但想到的东西最后必须以某种形式出现在正文里，不能只留在脑子里。
</character_voice>`;

export function readCompanionThought(value) {
  let text = null;
  const content = String(value || "").replace(
    /```[\s\S]*?(?:```|$)|<(thinking|think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<companion_thought\b[^>]*>([\s\S]*?)(<\/companion_thought\s*>|$)|\[\[\s*思考\s*[:：]?\s*([\s\S]*?)(\]\]|$)/gi,
    (block, providerTag, tagged, tagEnd, bracketed, bracketEnd) => {
      if (providerTag || block.startsWith("```")) return block;
      if ((tagEnd || bracketEnd) && !text) {
        text = (tagged ?? bracketed).replace(/<(thinking|think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
          .replace(/<[^>]*>/g, "").trim() || null;
      }
      return "";
    }
  ).trim();
  return { text, content };
}
