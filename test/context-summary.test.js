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
