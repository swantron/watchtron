import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, getService } from '../index.js';

/** Write a one-service registry to a temp file; `extra` is appended under the service. */
function writeRegistry(extra = '') {
  const file = join(mkdtempSync(join(tmpdir(), 'wt-reg-')), 'services.yaml');
  writeFileSync(
    file,
    `services:
  demo:
    url: https://demo.test
    whiteBox: false
    mode: post-deploy
    criticalRoutes:
      - /
    healthGate:
      availabilityPct: 99
      p95LatencyMs: 1000
${extra}`
  );
  return file;
}

test('loads and validates the real fleet registry', () => {
  const { services, list } = loadRegistry();
  const names = list();
  assert.equal(names.length, 6);
  for (const expected of ['tronswan', 'chomptron', 'swantron', 'mt', 'wrenchtron', 'jswan.dev']) {
    assert.ok(names.includes(expected), `registry missing ${expected}`);
  }
  // White-box services must declare an expectedServiceName.
  assert.equal(services.tronswan.expectedServiceName, 'tronswan-web');
  assert.equal(services.chomptron.expectedServiceName, 'chomptron-web');
});

test('getService throws helpfully for unknown service', () => {
  assert.throws(() => getService('nope'), /unknown service "nope"/);
});

test('getService returns a named entry', () => {
  const svc = getService('mt');
  assert.equal(svc.name, 'mt');
  assert.equal(svc.whiteBox, false);
});

test('accepts optional probe tuning and failClosed', () => {
  const file = writeRegistry(
    `    failClosed: true
    probe:
      requestsPerRoute: 10
      timeoutMs: 5000
      waitMs: 25000
`
  );
  const svc = getService('demo', file);
  assert.equal(svc.failClosed, true);
  assert.equal(svc.probe.requestsPerRoute, 10);
  assert.equal(svc.probe.waitMs, 25000);
});

test('rejects a non-numeric probe field', () => {
  const file = writeRegistry(
    `    probe:
      requestsPerRoute: lots
`
  );
  assert.throws(() => loadRegistry(file), /probe\.requestsPerRoute must be a number/);
});

test('rejects a non-boolean failClosed', () => {
  const file = writeRegistry(`    failClosed: nope-string\n`);
  assert.throws(() => loadRegistry(file), /failClosed must be a boolean/);
});

test('chomptron centralizes its Cloud Run probe tuning in the registry', () => {
  const chomptron = getService('chomptron');
  assert.equal(chomptron.probe.requestsPerRoute, 10);
  assert.equal(chomptron.probe.waitMs, 25000);
});
