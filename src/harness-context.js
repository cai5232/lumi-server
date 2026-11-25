// Keep the frontend's chosen threshold; clamp only the effective threshold for
// this model. The API route retains its existing window and configuration.
export function harnessContextPolicy(config, settings) {
  const reserve = 12000;
  // Preserve room for the response, tool results and estimation error.
  const compactionHeadroom = Math.max(reserve + 4000, Math.min(32000, Math.floor(config.contextTokens * 0.2)));
  const requestedTrigger = Number(settings.triggerTokensEstimate);
  return {
    contextTokens: config.contextTokens,
    inputBudget: config.contextTokens - reserve,
    triggerTokens: Math.min(requestedTrigger, Math.max(1, config.contextTokens - compactionHeadroom)),
    requestedTriggerTokens: requestedTrigger,
    preservedTailMinTurns: 10, preservedTailMaxTurns: 15, preservedTailTargetTokens: 20000,
    strategy: 'lumi-summary-rebuild',
  };
}
