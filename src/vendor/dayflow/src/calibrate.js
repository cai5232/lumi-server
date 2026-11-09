export const DEFAULT_CALIBRATION_CASES = Object.freeze([
  { id: 'time-conflict', description: 'Resolve a relative date from its source turn, not the current turn.' },
  { id: 'completed-event', description: 'Prefer the latest completion over an older pending state.' },
  { id: 'similar-distractor', description: 'Ignore a similar but superseded detail.' },
  { id: 'image-receipt', description: 'Distinguish image delivery from current pixel availability.' },
  { id: 'needle-recall', description: 'Use an explicit recalled source without promoting it to current state.' }
]);

const DEFAULT_CANDIDATES = Object.freeze([12_000, 20_000, 26_000, 32_000, 48_000, 64_000, 96_000, 128_000]);

function normalizeScore(result) {
  const score = typeof result === 'boolean' ? Number(result) : Number(result);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

function recommendationFor(clarityCeiling, floor) {
  const activateTokens = Math.max(floor, Math.floor(clarityCeiling * 0.8 / 1000) * 1000);
  const landingTokens = Math.max(4_000, Math.floor(activateTokens * 0.4 / 1000) * 1000);
  return {
    activateTokens,
    landingTokens,
    minimumTailTokens: Math.max(1_500, Math.floor(landingTokens * 0.3)),
    maximumTailTokens: Math.max(2_500, Math.floor(landingTokens * 0.5))
  };
}

function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) throw new TypeError('candidates must be a non-empty array');
  if (candidates.some(value => !Number.isInteger(value) || value < 10_000)) {
    throw new TypeError('candidates must contain integer token counts of at least 10000');
  }
  return [...new Set(candidates)].sort((left, right) => left - right);
}

/**
 * Probe a model at absolute working-set sizes. The callback returns a boolean
 * or a score from 0 to 1 for each case. Dayflow recommends the largest tested
 * size that remains above minScore, then leaves a safety margin for activation.
 */
export async function calibrate({
  probe,
  candidates = DEFAULT_CANDIDATES,
  cases = DEFAULT_CALIBRATION_CASES,
  minScore = 0.9
}) {
  if (typeof probe !== 'function') throw new TypeError('probe must be a function');
  candidates = validateCandidates(candidates);
  const measurements = [];
  for (const tokens of candidates) {
    const scores = [];
    for (const testCase of cases) {
      const result = await probe({ tokens, case: testCase });
      scores.push(normalizeScore(result));
    }
    measurements.push({
      tokens,
      score: scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length),
      scores
    });
  }

  const passing = measurements.filter(item => item.score >= minScore);
  const clarityCeiling = passing.length ? passing.at(-1).tokens : candidates[0];
  return {
    measurements,
    minScore,
    clarityCeiling,
    recommendation: recommendationFor(clarityCeiling, candidates[0])
  };
}

/**
 * Repeatedly probe a model, reject unstable token sizes, persist the resulting
 * custom profile, and periodically retest it. A model/prompt/tool combination
 * should use its own profileId because all three affect attention quality.
 */
export async function autoTune({
  probe,
  profileId = 'default',
  store,
  candidates = DEFAULT_CANDIDATES,
  cases = DEFAULT_CALIBRATION_CASES,
  samples = 3,
  minScore = 0.9,
  minStableRate = 0.8,
  retestAfterMs = 7 * 86_400_000,
  force = false,
  now = () => Date.now()
} = {}) {
  if (typeof probe !== 'function') throw new TypeError('probe must be a function');
  if (!Number.isInteger(samples) || samples < 2) throw new TypeError('samples must be an integer of at least 2');
  candidates = validateCandidates(candidates);
  const storageKey = `dayflow-tuning:${profileId}`;
  const timestamp = now();
  const cached = store && !force ? await store.load(storageKey) : null;
  if (cached?.version === 1 && timestamp - cached.tunedAt < retestAfterMs) {
    return { ...cached, cached: true };
  }

  const measurements = [];
  for (const tokens of candidates) {
    const scores = [];
    for (const testCase of cases) {
      for (let sample = 0; sample < samples; sample++) {
        scores.push(normalizeScore(await probe({ tokens, case: testCase, sample })));
      }
    }
    const score = scores.reduce((sum, value) => sum + value, 0) / Math.max(1, scores.length);
    const stableRate = scores.filter(value => value >= minScore).length / Math.max(1, scores.length);
    measurements.push({ tokens, score, stableRate, stable: score >= minScore && stableRate >= minStableRate, scores });
  }

  // Treat attention as a monotonic budget: stop at the first unstable size
  // instead of trusting a lucky pass at a larger size.
  let clarityCeiling;
  for (const measurement of measurements) {
    if (!measurement.stable) break;
    clarityCeiling = measurement.tokens;
  }
  clarityCeiling ||= candidates[0];
  const report = {
    version: 1,
    profileId,
    tunedAt: timestamp,
    retestAfterMs,
    samples,
    minScore,
    minStableRate,
    clarityCeiling,
    confidence: measurements[0]?.stable ? 'stable' : 'low',
    profile: recommendationFor(clarityCeiling, candidates[0]),
    measurements,
    cached: false
  };
  if (store) await store.save(storageKey, report);
  return report;
}
