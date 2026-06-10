/**
 * Verdict logic: given the spans the control plane actually received for a run,
 * plus the service's registry entry, decide whether the deploy is verified.
 *
 * This is the authority. The prober computes client-side signals too, but the
 * point of watchtron is that the control plane only passes a deploy if the
 * telemetry for that run actually LANDED here -- proving real end-to-end flow,
 * not just that a CI step exited 0.
 */

/** @param {number[]} values @param {number} p e.g. 95 */
function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Pull the request path off a prober span (set as url.path, fallback http.route). */
function spanPath(s) {
  return s.attrs['url.path'] || s.attrs['http.route'] || s.attrs['http.target'] || null;
}

/**
 * @param {import('./otlp.js').SpanRecord[]} spans Spans matching this runId.
 * @param {object} service Registry entry (must include criticalRoutes, healthGate, whiteBox).
 * @param {string} runId
 * @param {string|null} [expectVersion] If set (and the origin reports a real version),
 *   assert the correlated server span is running this version (proves the NEW deploy is live).
 */
export function verifyRun(spans, service, runId, expectVersion = null) {
  const reasons = [];
  const proberSpans = spans.filter((s) => s.role === 'prober');

  if (proberSpans.length === 0) {
    return {
      service: service.name,
      runId,
      pass: false,
      proberSpans: 0,
      availabilityPct: 0,
      p95LatencyMs: 0,
      routesCovered: [],
      routesMissing: service.criticalRoutes,
      whiteBox: !!service.whiteBox,
      endToEnd: service.whiteBox ? false : null,
      expectedVersion: expectVersion || null,
      servedVersion: null,
      versionMatch: null,
      reasons: [
        'no prober spans received for this run id (did traffic + OTLP export reach the control plane?)',
      ],
    };
  }

  // Availability: a probe "succeeded" if it got a non-error HTTP status.
  const succeeded = proberSpans.filter((s) => s.statusCode && s.statusCode > 0 && s.statusCode < 400);
  const availabilityPct = (succeeded.length / proberSpans.length) * 100;

  // Latency from the prober's measured client-span durations.
  const durations = proberSpans.map((s) => s.durationMs).filter((d) => d > 0);
  const p95LatencyMs = Math.round(percentile(durations, 95));

  // Route coverage vs the registry's critical routes.
  const covered = new Set(proberSpans.map(spanPath).filter(Boolean));
  const routesCovered = [...covered];
  const routesMissing = service.criticalRoutes.filter((r) => !covered.has(r));

  // White-box: confirm a SERVER span for this run shares a trace with a prober
  // span -> the request truly reached the instrumented origin (not just an edge
  // cache / CDN). SpanKind 2 == SERVER.
  let endToEnd = null;
  const proberTraceIds = new Set(proberSpans.map((s) => s.traceId));
  if (service.whiteBox) {
    const serverSpans = spans.filter(
      (s) => s.role === 'server' || s.kind === 2 || s.serviceName === service.expectedServiceName
    );
    endToEnd = serverSpans.some((s) => proberTraceIds.has(s.traceId));
  }

  // Version assertion (white-box only): prove the CORRELATED server span is
  // running the version this deploy expects -- i.e. the new code is actually
  // serving, not a stale instance still answering. Stays a no-op unless an
  // expected version was supplied AND the origin reports a real (non-default)
  // version, so it never trips a service that isn't wired to report one yet.
  let servedVersion = null;
  let versionMatch = null;
  if (service.whiteBox && expectVersion) {
    const correlatedVersions = spans
      .filter((s) => (s.role === 'server' || s.kind === 2) && proberTraceIds.has(s.traceId))
      .map((s) => s.serviceVersion)
      .filter((v) => v && v !== '0.0.0');
    if (correlatedVersions.length > 0) {
      servedVersion = correlatedVersions[0];
      versionMatch = correlatedVersions.includes(expectVersion);
    }
  }

  // Apply the deploy health gate.
  if (availabilityPct < service.healthGate.availabilityPct) {
    reasons.push(`availability ${availabilityPct.toFixed(1)}% < gate ${service.healthGate.availabilityPct}%`);
  }
  if (p95LatencyMs > service.healthGate.p95LatencyMs) {
    reasons.push(`p95 latency ${p95LatencyMs}ms > gate ${service.healthGate.p95LatencyMs}ms`);
  }
  if (routesMissing.length > 0) {
    reasons.push(`critical routes never probed: ${routesMissing.join(', ')}`);
  }
  if (service.whiteBox && !endToEnd) {
    reasons.push(
      `white-box: no server span (service.name=${service.expectedServiceName}) correlated with prober traffic -- request may not have reached the instrumented origin`
    );
  }
  if (versionMatch === false) {
    reasons.push(
      `served version ${servedVersion} != expected ${expectVersion} -- a stale instance may still be live (new deploy not fully rolled out?)`
    );
  }

  return {
    service: service.name,
    runId,
    pass: reasons.length === 0,
    proberSpans: proberSpans.length,
    availabilityPct: Number(availabilityPct.toFixed(1)),
    p95LatencyMs,
    routesCovered,
    routesMissing,
    whiteBox: !!service.whiteBox,
    endToEnd,
    expectedVersion: expectVersion || null,
    servedVersion,
    versionMatch,
    reasons,
  };
}
