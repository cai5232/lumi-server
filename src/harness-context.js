// Keep the frontend's chosen threshold; clamp only the effective threshold for
// this model. The API route retains its existing window and configuration.
export function harnessContextPolicy(config, settings) {
  const reserve = 12000;
  const requestedTrigger = Number(settings.triggerTokensEstimate);
  return {
    contextTokens: config.contextTokens,
    inputBudget: config.contextTokens - reserve,
    triggerTokens: Math.min(requestedTrigger, Math.floor((config.contextTokens - reserve) * 0.8)),
    requestedTriggerTokens: requestedTrigger,
    preservedTailMinTurns: 10, preservedTailMaxTurns: 15, preservedTailTargetTokens: 20000,
    strategy: 'lumi-summary-rebuild',
  };
}
