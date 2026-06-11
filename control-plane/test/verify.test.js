import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRun } from '../src/verify.js';

const tronswan = {
  name: 'tronswan',
  whiteBox: true,
  expectedServiceName: 'tronswan-web',
  criticalRoutes: ['/', '/projects'],
  healthGate: { availabilityPct: 99, p95LatencyMs: 1500 },
};

function proberSpan({ route = '/', status = 200, durationMs = 100, traceId = 'a'.repeat(32) }) {
  return {
    traceId,
    spanId: 'b'.repeat(16),
    role: 'prober',
    kind: 3,
    serviceName: 'watchtron-prober',
    watchtronService: 'tronswan',
    statusCode: status,
    durationMs,
    attrs: { 'synthetic.run_id': 'run-1', 'url.path': route },
    receivedAt: Date.now(),
  };
}

function serverSpan({ traceId = 'a'.repeat(32), version, durationMs = 50 } = {}) {
  return {
    traceId,
    spanId: 'c'.repeat(16),
    role: 'server',
    kind: 2,
    serviceName: 'tronswan-web',
    serviceVersion: version,
    statusCode: 200,
    durationMs,
    attrs: { 'synthetic.run_id': 'run-1' },
    receivedAt: Date.now(),
  };
}

test('passes when health gate met, all routes covered, and server span correlates', () => {
  const spans = [
    proberSpan({ route: '/', traceId: 't1' }),
    proberSpan({ route: '/projects', traceId: 't2' }),
    serverSpan({ traceId: 't1' }),
  ];
  const v = verifyRun(spans, tronswan, 'run-1');
  assert.equal(v.pass, true);
  assert.equal(v.endToEnd, true);
  assert.deepEqual(v.routesMissing, []);
});

test('fails when a critical route was never probed', () => {
  const spans = [proberSpan({ route: '/', traceId: 't1' }), serverSpan({ traceId: 't1' })];
  const v = verifyRun(spans, tronswan, 'run-1');
  assert.equal(v.pass, false);
  assert.ok(v.reasons.some((r) => r.includes('/projects')));
});

test('fails when availability below the gate', () => {
  const spans = [
    proberSpan({ route: '/', status: 500, traceId: 't1' }),
    proberSpan({ route: '/projects', traceId: 't2' }),
    serverSpan({ traceId: 't1' }),
  ];
  const v = verifyRun(spans, tronswan, 'run-1');
  assert.equal(v.pass, false);
  assert.ok(v.reasons.some((r) => r.includes('availability')));
});

test('white-box fails when no server span correlates', () => {
  const spans = [
    proberSpan({ route: '/', traceId: 't1' }),
    proberSpan({ route: '/projects', traceId: 't2' }),
  ];
  const v = verifyRun(spans, tronswan, 'run-1');
  assert.equal(v.endToEnd, false);
  assert.ok(v.reasons.some((r) => r.includes('white-box')));
});

test('no spans -> hard fail with helpful reason', () => {
  const v = verifyRun([], tronswan, 'run-1');
  assert.equal(v.pass, false);
  assert.equal(v.proberSpans, 0);
});

test('black-box service does not require a server span', () => {
  const mt = {
    name: 'mt',
    whiteBox: false,
    criticalRoutes: ['/'],
    healthGate: { availabilityPct: 99, p95LatencyMs: 1200 },
  };
  const v = verifyRun([proberSpan({ route: '/', traceId: 't1' })], mt, 'run-1');
  assert.equal(v.pass, true);
  assert.equal(v.endToEnd, null);
});

function healthySpans(version) {
  return [
    proberSpan({ route: '/', traceId: 't1' }),
    proberSpan({ route: '/projects', traceId: 't2' }),
    serverSpan({ traceId: 't1', version }),
  ];
}

test('version assertion passes when the correlated server span matches', () => {
  const v = verifyRun(healthySpans('sha-abc'), tronswan, 'run-1', 'sha-abc');
  assert.equal(v.pass, true);
  assert.equal(v.versionMatch, true);
  assert.equal(v.servedVersion, 'sha-abc');
});

test('version assertion fails on a mismatch (stale instance still serving)', () => {
  const v = verifyRun(healthySpans('sha-old'), tronswan, 'run-1', 'sha-new');
  assert.equal(v.pass, false);
  assert.equal(v.versionMatch, false);
  assert.equal(v.servedVersion, 'sha-old');
  assert.ok(v.reasons.some((r) => r.includes('served version')));
});

test('version assertion is skipped when the origin reports only the default version', () => {
  const v = verifyRun(healthySpans('0.0.0'), tronswan, 'run-1', 'sha-new');
  assert.equal(v.pass, true);
  assert.equal(v.versionMatch, null);
  assert.equal(v.servedVersion, null);
});

test('version assertion is a no-op when no expected version is supplied', () => {
  const v = verifyRun(healthySpans('sha-abc'), tronswan, 'run-1');
  assert.equal(v.pass, true);
  assert.equal(v.versionMatch, null);
  assert.equal(v.expectedVersion, null);
});

test('version assertion does not apply to black-box services', () => {
  const mt = {
    name: 'mt',
    whiteBox: false,
    criticalRoutes: ['/'],
    healthGate: { availabilityPct: 99, p95LatencyMs: 1200 },
  };
  const v = verifyRun([proberSpan({ route: '/', traceId: 't1' })], mt, 'run-1', 'sha-new');
  assert.equal(v.pass, true);
  assert.equal(v.versionMatch, null);
});

test('error breakdown splits 4xx, 5xx, and transport failures', () => {
  const spans = [
    proberSpan({ route: '/', status: 404, traceId: 't1' }),
    proberSpan({ route: '/projects', status: 503, traceId: 't2' }),
    proberSpan({ route: '/', status: 0, traceId: 't3' }),
  ];
  const v = verifyRun(spans, tronswan, 'run-1');
  assert.deepEqual(v.errorBreakdown, { http4xx: 1, http5xx: 1, transport: 1 });
});

test('server-side latency p95 is computed from correlated server spans (white-box)', () => {
  const spans = [
    proberSpan({ route: '/', traceId: 't1' }),
    proberSpan({ route: '/projects', traceId: 't2' }),
    serverSpan({ traceId: 't1', durationMs: 40 }),
    serverSpan({ traceId: 't2', durationMs: 60 }),
  ];
  const v = verifyRun(spans, tronswan, 'run-1');
  assert.equal(v.pass, true);
  assert.equal(v.serverP95LatencyMs, 60);
});

test('server-side latency is null for black-box services', () => {
  const mt = {
    name: 'mt',
    whiteBox: false,
    criticalRoutes: ['/'],
    healthGate: { availabilityPct: 99, p95LatencyMs: 1200 },
  };
  const v = verifyRun([proberSpan({ route: '/', traceId: 't1' })], mt, 'run-1');
  assert.equal(v.serverP95LatencyMs, null);
});

test('server-side latency is informational when no server gate is configured', () => {
  const spans = [
    proberSpan({ route: '/', traceId: 't1' }),
    proberSpan({ route: '/projects', traceId: 't2' }),
    serverSpan({ traceId: 't1', durationMs: 9999 }),
  ];
  const v = verifyRun(spans, tronswan, 'run-1');
  assert.equal(v.serverP95LatencyMs, 9999);
  assert.equal(v.pass, true);
});

test('optional server-side latency gate fails when configured and exceeded', () => {
  const svc = {
    name: 'tronswan',
    whiteBox: true,
    expectedServiceName: 'tronswan-web',
    criticalRoutes: ['/', '/projects'],
    healthGate: { availabilityPct: 99, p95LatencyMs: 1500, serverP95LatencyMs: 30 },
  };
  const spans = [
    proberSpan({ route: '/', traceId: 't1' }),
    proberSpan({ route: '/projects', traceId: 't2' }),
    serverSpan({ traceId: 't1', durationMs: 100 }),
  ];
  const v = verifyRun(spans, svc, 'run-1');
  assert.equal(v.pass, false);
  assert.equal(v.serverP95LatencyMs, 100);
  assert.ok(v.reasons.some((r) => r.includes('server-side p95')));
});
