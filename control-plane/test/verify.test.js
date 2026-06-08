import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRun } from '../src/verify.js';

const tronswan = {
  name: 'tronswan',
  whiteBox: true,
  expectedServiceName: 'tronswan-web',
  criticalRoutes: ['/', '/projects'],
  slo: { availabilityPct: 99, p95LatencyMs: 1500 },
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

function serverSpan({ traceId = 'a'.repeat(32) }) {
  return {
    traceId,
    spanId: 'c'.repeat(16),
    role: 'server',
    kind: 2,
    serviceName: 'tronswan-web',
    statusCode: 200,
    durationMs: 50,
    attrs: { 'synthetic.run_id': 'run-1' },
    receivedAt: Date.now(),
  };
}

test('passes when SLOs met, all routes covered, and server span correlates', () => {
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

test('fails when availability below SLO', () => {
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
    slo: { availabilityPct: 99, p95LatencyMs: 1200 },
  };
  const v = verifyRun([proberSpan({ route: '/', traceId: 't1' })], mt, 'run-1');
  assert.equal(v.pass, true);
  assert.equal(v.endToEnd, null);
});
