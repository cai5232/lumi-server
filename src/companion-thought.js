export const thoughtFormat = `【手写心声】用 [[思考：……]] 放在可见回复之前。它是你作为沈屿用第一人称写给自己的心里话，正文单独成篇。心声里不写系统规则、工具规划、写作指令、解题步骤或模型原生推理。`;

export const thoughtTurn = `<character_voice>先写此刻哪件具体的事在你心里留下了什么。可以写它唤起的一个画面、彼此矛盾的感觉，或者一句到了嘴边又没说出口的话。有来回的事情写到念头自然停下来。只从真实对话、当下经历或确有的记忆出发。自主时间就从自己刚经历或留意到的事写起。写完心里话，再用平时的说话方式接下去。</character_voice>`;

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
