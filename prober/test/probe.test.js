import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { probeService } from '../src/probe.js';

/** Start a tiny HTTP server that records every request path; returns helpers. */
async function withServer(handler, fn) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ path: req.url, warmup: req.headers['x-synthetic-warmup'] === 'true' });
    (handler || ((_req, r) => r.end('ok')))(req, res);
  });
  await new Promise((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ baseUrl, hits });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const service = { name: 'demo', criticalRoutes: ['/'] };

test('warm-up fires priming requests that are not counted in the signals', async () => {
  await withServer(null, async ({ baseUrl, hits }) => {
    const { signals } = await probeService({
      service,
      runId: 'run-1',
      baseUrl,
      requestsPerRoute: 2,
      warmupPerRoute: 1,
    });
    // 1 warm-up + 2 measured for the single route.
    assert.equal(hits.length, 3);
    assert.equal(hits.filter((h) => h.warmup).length, 1);
    // Only the measured burst counts toward the verdict signals.
    assert.equal(signals.total, 2);
    assert.equal(signals.succeeded, 2);
  });
});

test('no warm-up requests are sent when warmupPerRoute is 0', async () => {
  await withServer(null, async ({ baseUrl, hits }) => {
    await probeService({ service, runId: 'run-2', baseUrl, requestsPerRoute: 2, warmupPerRoute: 0 });
    assert.equal(hits.length, 2);
    assert.equal(hits.filter((h) => h.warmup).length, 0);
  });
});

test('warm-up tolerates a failing priming request and still measures the burst', async () => {
  let first = true;
  const handler = (_req, res) => {
    if (first) {
      first = false;
      res.statusCode = 503; // simulate a cold/unready origin on the warm-up
    }
    res.end('ok');
  };
  await withServer(handler, async ({ baseUrl }) => {
    const { signals } = await probeService({
      service,
      runId: 'run-3',
      baseUrl,
      requestsPerRoute: 2,
      warmupPerRoute: 1,
    });
    // Warm-up failure is swallowed; the two measured requests still succeed.
    assert.equal(signals.total, 2);
    assert.equal(signals.succeeded, 2);
  });
});
