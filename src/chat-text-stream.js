const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function startChatTextStream(res, text, { chunkSize = 6, delayMs = 18 } = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*"
  });
  res.write(": connected\n\n");
  if (typeof text !== "string" || !text) return;
  const graphemes = typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(text), part => part.segment)
    : Array.from(text);
  for (let index = 0; index < graphemes.length; index += chunkSize) {
    const content = graphemes.slice(index, index + chunkSize).join("");
    res.write(`data: ${JSON.stringify({ type: "text", content })}\n\n`);
    if (index + chunkSize < graphemes.length) await sleep(delayMs);
  }
}

export function finishChatTextStream(res, response) {
  res.write(`data: ${JSON.stringify({ type: "complete", response })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  res.end();
}

export function failChatTextStream(res, error) {
  res.write(`data: ${JSON.stringify({ type: "error", content: String(error?.message || error || "生成失败") })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  res.end();
}

export async function sendChatTextResponse(res, response) {
  const message = response?.assistantMessage;
  const content = message?.contentType === "html" ? "" : String(message?.content || "");
  await startChatTextStream(res, content);
  finishChatTextStream(res, response);
}
