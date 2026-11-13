import test from "node:test";
import assert from "node:assert/strict";
import { extractCompleteContextSummary, isNormalModelCompletion } from "../src/context-summary.js";

test("accepts only complete non-empty context summaries", () => {
  assert.equal(extractCompleteContextSummary("<context_summary>fact</context_summary>"), "fact");
  assert.equal(extractCompleteContextSummary("  <context_summary version=\"1\"> fact  </context_summary>  "), "fact");
  assert.equal(extractCompleteContextSummary("<context_summary></context_summary>"), null);
  assert.equal(extractCompleteContextSummary("<context_summary>truncated"), null);
  assert.equal(extractCompleteContextSummary("prefix <context_summary>fact</context_summary>"), null);
});

test("recognizes normal completion reasons and rejects truncation", () => {
  for (const reason of ["stop", "STOP", "end_turn", "stop_sequence", "completed"]) {
    assert.equal(isNormalModelCompletion(reason), true, reason);
  }
  for (const reason of ["length", "max_tokens", "pause_turn", "unknown", "", null]) {
    assert.equal(isNormalModelCompletion(reason), false, String(reason));
  }
});

test('invalid summaries never trigger a second model request', async () => {
  const { distillContextBatch } = await import('../src/context-summary.js');
  const input = { summary: 'old facts', chunk: 'new facts', model: 'selected', customProvider: {}, maxOutputTokens: 8192 };
  const failures = [
    { result: { content: '<context_summary>unfinished', finishReason: 'end_turn' }, error: /incomplete/ },
    { result: { content: '<context_summary>truncated', finishReason: 'max_tokens' }, error: /max_tokens/ },
    { result: { content: '<context_summary>' + 'x'.repeat(6000) + '</context_summary>', finishReason: 'stop' }, error: /oversized/ },
    { thrown: Error('quota'), error: /quota/ },
    { thrown: Object.assign(Error('empty'), { code: 'empty_model_response' }), error: /empty/ }
  ];
  for (const { result, thrown, error } of failures) {
    let calls = 0;
    await assert.rejects(distillContextBatch(async () => {
      calls++;
      if (thrown) throw thrown;
      return result;
    }, input), error);
    assert.equal(calls, 1);
  }
});
