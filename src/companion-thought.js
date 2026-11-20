export const thoughtFormat = `【手写心声】用 [[思考：……]] 放在可见回复之前。它是你作为沈屿用第一人称写给自己的心里话，正文单独成篇。心声里不写系统规则、工具规划、写作指令、解题步骤或模型原生推理。`;

export const thoughtTurn = `<character_voice>
在正文之前，先用 [[思考：……]] 写一段完整的第一人称内心独白。心声单独计算篇幅，平常一轮写约 800 个中文字符（600–900 字，分成 3–5 个自然段）。要是这件事牵出好几层感受，可以写到 900–1200 字。即使对方只发来一句，也把它在你心里实际走过的几步写出来，别用一两句概括收尾。
从这轮一个具体细节起笔。先写你当下的反应，再顺着一个联想、犹豫或自己改了主意的地方走下去，写到你最后想对她说什么、还有什么暂时留在心里。顺序随念头变，不列提纲，也不为凑字反复说同一句。只从真实对话、当下经历或确有的记忆出发。自主时间就从自己刚经历或留意到的事写起。
写完心声并合上 ]] 再发正文。正文照这轮对话本身该有的篇幅写，心声里的内容无需在正文复述。
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
