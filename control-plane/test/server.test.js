import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { SpanBuffer } from '../src/buffer.js';
import { VerdictStore } from '../src/verdict-store.js';
import { BaselineStore } from '../src/baseline-store.js';

// Exercises the real Express app over a loopback port: OTLP ingest -> /verify ->
// /badge round-trip, token enforcement, and request validation. State is
// injected (in-memory VerdictStore, fresh SpanBuffer) so tests touch no disk.

/** Start the app on an ephemeral port; returns { base, close }. */
async function startServer(opts = {}) {
  const app = createApp({
    buffer: new SpanBuffer(),
    verdicts: new VerdictStore(), // no file -> in-memory only
    baselines: new BaselineStore(), // no file -> in-memory only (don't touch disk in tests)
    ...opts,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Build a minimal OTLP/HTTP JSON body wrapping one prober client span. */
function proberOtlp({ service = 'mt', runId = 'run-1', route = '/', status = 200, durationMs = 100 }) {
  const startNano = 1_000_000;
  const endNano = startNano + durationMs * 1e6;
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'watchtron-prober' } }] },
        scopeSpans: [
          {
            scope: { name: 'watchtron-prober' },
            spans: [
              {
                traceId: 'a'.repeat(32),
                spanId: 'b'.repeat(16),
                name: `GET ${route}`,
                kind: 3,
                startTimeUnixNano: String(startNano),
                endTimeUnixNano: String(endNano),
                attributes: [
                  { key: 'watchtron.role', value: { stringValue: 'prober' } },
                  { key: 'watchtron.service', value: { stringValue: service } },
                  { key: 'synthetic.run_id', value: { stringValue: runId } },
                  { key: 'url.path', value: { stringValue: route } },
                  { key: 'http.response.status_code', value: { intValue: String(status) } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

test('healthz reports liveness', async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  } finally {
    await close();
  }
});

test('ingest -> verify -> badge round-trip for a healthy black-box service', async () => {
  const { base, close } = await startServer();
  try {
    const ingest = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proberOtlp({ service: 'mt', runId: 'run-1' })),
    });
    assert.equal(ingest.status, 200);

    const verify = await fetch(`${base}/verify?service=mt&runId=run-1`);
    assert.equal(verify.status, 200);
    const verdict = await verify.json();
    assert.equal(verdict.pass, true);
    assert.equal(verdict.availabilityPct, 100);

    // The verdict is now the service's "last result" behind the badge.
    const badge = await fetch(`${base}/badge/mt`);
    const shield = await badge.json();
    assert.equal(shield.message, 'verified');
    assert.equal(shield.color, 'brightgreen');
  } finally {
    await close();
  }
});

test('verify returns 422 and a red badge when the gate fails', async () => {
  const { base, close } = await startServer();
  try {
    await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proberOtlp({ service: 'mt', runId: 'run-2', status: 500 })),
    });
    const verify = await fetch(`${base}/verify?service=mt&runId=run-2`);
    assert.equal(verify.status, 422);
    const verdict = await verify.json();
    assert.equal(verdict.pass, false);
    assert.ok(verdict.reasons.some((r) => r.includes('gate')));

    const shield = await (await fetch(`${base}/badge/mt`)).json();
    assert.equal(shield.message, 'failing');
    assert.equal(shield.color, 'red');
  } finally {
    await close();
  }
});

test('verify validates params and unknown services', async () => {
  const { base, close } = await startServer();
  try {
    assert.equal((await fetch(`${base}/verify`)).status, 400);
    assert.equal((await fetch(`${base}/verify?service=mt`)).status, 400);
    assert.equal((await fetch(`${base}/verify?service=nope&runId=x`)).status, 404);
  } finally {
    await close();
  }
});

test('badge is unknown/grey for a service that has never been verified', async () => {
  const { base, close } = await startServer();
  try {
    const shield = await (await fetch(`${base}/badge/mt`)).json();
    assert.equal(shield.message, 'unknown');
    assert.equal(shield.color, 'lightgrey');
  } finally {
    await close();
  }
});

test('token guard: 401 without credentials, 200 with the bearer token', async () => {
  const { base, close } = await startServer({ token: 'secret' });
  try {
    const body = JSON.stringify(proberOtlp({ runId: 'run-3' }));
    const noAuth = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(noAuth.status, 401);

    const withAuth = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body,
    });
    assert.equal(withAuth.status, 200);

    // Unprotected liveness endpoint stays open even with a token configured.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    await close();
  }
});

test('baseline builds from passing runs and flags a regression (informational)', async () => {
  const baselines = new BaselineStore(); // in-memory, shared across this server's calls
  const { base, close } = await startServer({ baselines });
  try {
    // Five healthy ~100ms runs establish the baseline.
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(proberOtlp({ service: 'mt', runId: `base-${i}`, durationMs: 100 })),
      });
      const v = await (await fetch(`${base}/verify?service=mt&runId=base-${i}`)).json();
      assert.equal(v.pass, true);
    }

    // A 3x-slower run: still under mt's absolute gate, but a regression vs history.
    await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proberOtlp({ service: 'mt', runId: 'slow', durationMs: 300 })),
    });
    const v = await (await fetch(`${base}/verify?service=mt&runId=slow`)).json();
    assert.equal(v.pass, true); // informational — regression does not fail the gate by default
    assert.equal(v.baseline.baselineP95, 100);
    assert.equal(v.baseline.regressed, true);
    assert.ok(v.baseline.regressionPct >= 100);
  } finally {
    await close();
  }
});

test('api/status carries the persisted last verdict', async () => {
  const verdicts = new VerdictStore();
  const { base, close } = await startServer({ verdicts });
  try {
    await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proberOtlp({ service: 'mt', runId: 'run-4' })),
    });
    await fetch(`${base}/verify?service=mt&runId=run-4`);

    const status = await (await fetch(`${base}/api/status`)).json();
    const mt = status.services.find((s) => s.name === 'mt');
    assert.equal(mt.lastVerdict.pass, true);
    assert.ok(status.buffer.total >= 1);
  } finally {
    await close();
  }
});
