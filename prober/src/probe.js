import { performance } from 'node:perf_hooks';
import { request } from 'undici';
import { newTraceId, newSpanId, traceparent, nowNano, plusMsNano } from './ids.js';

const USER_AGENT = 'watchtron-prober/0.1 (+https://github.com/swantron/watchtron)';

/**
 * Probe a single URL once, producing a prober CLIENT span.
 *
 * Each request gets a fresh trace id + a W3C traceparent header so a white-box
 * origin continues the trace. We also send x-synthetic-run-id / x-synthetic so
 * the origin's middleware can stamp the run id onto its server span.
 *
 * @param {object} args
 * @param {string} args.service      registry service name
 * @param {string} args.runId
 * @param {string} args.baseUrl
 * @param {string} args.route
 * @param {number} args.timeoutMs
 */
async function probeOnce({ service, runId, baseUrl, route, timeoutMs }) {
  const traceId = newTraceId();
  const spanId = newSpanId();
  const url = new URL(route, baseUrl);
  const startNano = nowNano();
  const t0 = performance.now();

  let statusCode = 0;
  let ok = false;
  let error = null;
  try {
    const res = await request(url.href, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        traceparent: traceparent(traceId, spanId),
        'x-synthetic-run-id': runId,
        'x-synthetic': 'true',
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    statusCode = res.statusCode;
    ok = statusCode > 0 && statusCode < 400;
    // Drain the body so the socket is released and timing is realistic.
    await res.body.text();
  } catch (err) {
    error = err?.code || err?.message || 'request_failed';
  }
  const durationMs = performance.now() - t0;

  const attrs = {
    'watchtron.role': 'prober',
    'watchtron.service': service,
    'synthetic.run_id': runId,
    synthetic: true,
    'http.request.method': 'GET',
    'url.full': url.href,
    'url.path': route,
    'server.address': url.host,
  };
  if (statusCode) attrs['http.response.status_code'] = statusCode;
  if (error) attrs['error.type'] = error;

  return {
    traceId,
    spanId,
    name: `GET ${route}`,
    startNano,
    endNano: plusMsNano(startNano, durationMs),
    durationMs,
    statusCode,
    ok,
    error,
    route,
    attrs,
  };
}

/**
 * Best-effort warm-up hit. Fired (and discarded) before the measured burst so a
 * scaled-to-zero origin (e.g. Cloud Run) absorbs its cold start here instead of
 * in the timed requests. Deliberately carries no traceparent / run id so it
 * never correlates into a verdict; errors are swallowed.
 *
 * @param {object} args
 * @param {string} args.baseUrl
 * @param {string} args.route
 * @param {number} args.timeoutMs
 */
async function warmUp({ baseUrl, route, timeoutMs }) {
  try {
    const url = new URL(route, baseUrl);
    const res = await request(url.href, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, 'x-synthetic': 'true', 'x-synthetic-warmup': 'true' },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    await res.body.text();
  } catch {
    // Warm-up is best-effort; a failure just means the measured burst eats the cold start.
  }
}

/**
 * Drive synthetic traffic across all critical routes of a service.
 * @param {object} args
 * @param {object} args.service   registry entry (with name, url, criticalRoutes, healthGate)
 * @param {string} args.runId
 * @param {string} [args.baseUrl] override (defaults to service.url)
 * @param {number} [args.requestsPerRoute]
 * @param {number} [args.timeoutMs]
 * @param {number} [args.warmupPerRoute] discarded priming requests per route, fired first
 */
export async function probeService({
  service,
  runId,
  baseUrl = service.url,
  requestsPerRoute = 3,
  timeoutMs = 10_000,
  warmupPerRoute = 0,
}) {
  // Prime first (and wait): once the origin is warm, the measured burst reflects
  // steady-state latency rather than a one-off cold start.
  if (warmupPerRoute > 0) {
    const warm = [];
    for (const route of service.criticalRoutes) {
      for (let i = 0; i < warmupPerRoute; i++) {
        warm.push(warmUp({ baseUrl, route, timeoutMs }));
      }
    }
    await Promise.all(warm);
  }

  const tasks = [];
  for (const route of service.criticalRoutes) {
    for (let i = 0; i < requestsPerRoute; i++) {
      tasks.push(probeOnce({ service: service.name, runId, baseUrl, route, timeoutMs }));
    }
  }
  const spans = await Promise.all(tasks);

  // Client-side preview of the golden signals (the control plane is the
  // authority, but this is useful in logs and when running offline).
  const total = spans.length;
  const succeeded = spans.filter((s) => s.ok).length;
  const durations = spans.map((s) => s.durationMs).sort((a, b) => a - b);
  const p95 = durations.length
    ? Math.round(durations[Math.max(0, Math.ceil(0.95 * durations.length) - 1)])
    : 0;

  return {
    spans,
    signals: {
      total,
      succeeded,
      availabilityPct: Number(((succeeded / total) * 100).toFixed(1)),
      p95LatencyMs: p95,
    },
  };
}
