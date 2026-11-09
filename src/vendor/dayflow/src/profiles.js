const INTEGER_FIELDS = [
  'activateTokens',
  'landingTokens',
  'minimumTailTokens',
  'maximumTailTokens'
];

/** Absolute working-set presets. They intentionally ignore model window percentages. */
export const ATTENTION_PROFILES = Object.freeze({
  balanced: Object.freeze({
    activateTokens: 30_000,
    landingTokens: 12_000,
    minimumTailTokens: 4_500,
    maximumTailTokens: 7_000
  }),
  focused: Object.freeze({
    activateTokens: 26_000,
    landingTokens: 10_000,
    minimumTailTokens: 3_000,
    maximumTailTokens: 5_000
  }),
  frugal: Object.freeze({
    activateTokens: 24_000,
    landingTokens: 8_000,
    minimumTailTokens: 2_400,
    maximumTailTokens: 4_000
  }),
  feral: Object.freeze({
    activateTokens: 20_000,
    landingTokens: 6_000,
    minimumTailTokens: 1_600,
    maximumTailTokens: 3_000
  })
});

export const CONVERSATION_MODES = Object.freeze({
  daily: Object.freeze({ enabled: true, rebuildAfterRotations: 3, rebuildAfterMs: 86_400_000 }),
  technical: Object.freeze({
    enabled: true,
    budget: Object.freeze({
      activateTokens: 26_000,
      landingTokens: 19_000,
      minimumTailTokens: 7_000,
      maximumTailTokens: 10_000
    }),
    rebuildAfterRotations: 3,
    rebuildAfterMs: 86_400_000
  }),
  story: Object.freeze({
    enabled: false,
    reason: 'Long-form fiction and role-play require verbatim texture; lossy daily-state compaction is disabled.'
  })
});

export function validateBudget(value) {
  const budget = { ...value };
  for (const field of INTEGER_FIELDS) {
    if (!Number.isInteger(budget[field]) || budget[field] <= 0) {
      throw new TypeError(`${field} must be a positive integer`);
    }
  }
  if (budget.landingTokens >= budget.activateTokens) {
    throw new RangeError('landingTokens must be lower than activateTokens');
  }
  if (budget.minimumTailTokens > budget.maximumTailTokens) {
    throw new RangeError('minimumTailTokens cannot exceed maximumTailTokens');
  }
  if (budget.maximumTailTokens >= budget.activateTokens) {
    throw new RangeError('maximumTailTokens must be lower than activateTokens');
  }
  return Object.freeze(budget);
}

export function resolvePolicy({ mode = 'daily', profile = 'focused', customProfile } = {}) {
  const modePolicy = CONVERSATION_MODES[mode];
  if (!modePolicy) throw new RangeError(`Unknown Dayflow mode: ${mode}`);
  if (!modePolicy.enabled) return { mode, ...modePolicy };

  const budget = modePolicy.budget || (profile === 'custom'
    ? validateBudget(customProfile || {})
    : ATTENTION_PROFILES[profile]);
  if (!budget) throw new RangeError(`Unknown Dayflow profile: ${profile}`);

  return {
    mode,
    profile: modePolicy.budget ? 'mode-default' : profile,
    enabled: true,
    budget: validateBudget(budget),
    rebuildAfterRotations: modePolicy.rebuildAfterRotations,
    rebuildAfterMs: modePolicy.rebuildAfterMs
  };
}
