/**
 * Latency regression detection.
 *
 * The health gate catches an *absolute* breach (p95 over the registry ceiling),
 * but not slow creep or a sudden slowdown that's still under the ceiling. This
 * compares a run's client p95 against the service's recent history (a rolling
 * window of prior passing runs) and flags a significant regression.
 *
 * It is informational by default -- a regression annotates the verdict but does
 * not fail the deploy unless the registry opts in with healthGate.p95RegressionPct.
 */

/** @param {number[]} values */
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {number} currentP95
 * @param {number[]} priorSamples Recent p95s for the service (excludes this run).
 * @param {object} [opts]
 * @param {number} [opts.minSamples] Don't judge until we have this much history.
 * @param {number} [opts.tolerancePct] Regression if current exceeds baseline by more than this %.
 * @returns {{ baselineP95: number|null, regressionPct: number|null, regressed: boolean, samples: number }}
 */
export function assessRegression(currentP95, priorSamples, { minSamples = 5, tolerancePct = 50 } = {}) {
  const samples = Array.isArray(priorSamples) ? priorSamples.length : 0;
  if (samples < minSamples) {
    return { baselineP95: null, regressionPct: null, regressed: false, samples };
  }
  const baselineP95 = median(priorSamples);
  const regressionPct = baselineP95 > 0 ? Math.round(((currentP95 - baselineP95) / baselineP95) * 100) : 0;
  return { baselineP95, regressionPct, regressed: regressionPct > tolerancePct, samples };
}
