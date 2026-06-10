import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRegistry } from '@watchtron/registry';
import { SpanBuffer } from './buffer.js';
import { VerdictStore } from './verdict-store.js';
import { decodeOtlpJson } from './otlp.js';
import { verifyRun } from './verify.js';

const here = dirname(fileURLToPath(import.meta.url));

// Verdicts back the dashboard + badges and must survive a restart, so they are
// mirrored to disk. Default lives at control-plane/state/ (gitignored, and the
// deploy does `git reset --hard` not `git clean`, so it survives redeploys).
const STATE_FILE = process.env.WATCHTRON_STATE_FILE || join(here, '..', 'state', 'verdicts.json');

export function createApp({
  buffer = new SpanBuffer(),
  registry = loadRegistry(),
  verdicts = new VerdictStore({ file: STATE_FILE }),
  token = process.env.WATCHTRON_TOKEN || '',
} = {}) {
  const app = express();
  // OTLP/HTTP JSON payloads can be chunky; allow a generous body.
  app.use(express.json({ limit: '8mb' }));

  /** Bearer-token guard. No-op when the token is unset (local dev). */
  function requireToken(req, res, next) {
    if (!token) return next();
    const auth = req.get('authorization') || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : req.get('x-watchtron-token');
    if (provided !== token) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  }

  // --- Liveness -----------------------------------------------------------
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', spans: buffer.size, uptimeSec: Math.round(process.uptime()) });
  });

  // --- OTLP/HTTP JSON trace ingest ---------------------------------------
  // Both the prober and white-box services export here.
  app.post('/v1/traces', requireToken, (req, res) => {
    try {
      const records = decodeOtlpJson(req.body);
      buffer.add(records);
      // OTLP success response shape.
      res.status(200).json({ partialSuccess: {} });
    } catch (err) {
      res.status(400).json({ error: 'failed to decode OTLP payload', detail: String(err?.message || err) });
    }
  });

  // --- Verify a synthetic run --------------------------------------------
  // GET /verify?service=tronswan&runId=...  -> verdict (pass/fail + signals)
  app.get('/verify', requireToken, (req, res) => {
    const { service: serviceName, runId } = req.query;
    if (!serviceName || !runId) {
      return res.status(400).json({ error: 'service and runId query params are required' });
    }
    const service = registry.services[serviceName];
    if (!service) {
      return res.status(404).json({ error: `unknown service "${serviceName}"`, known: registry.list() });
    }
    // Query by run id alone: it is globally unique and tags BOTH the prober
    // client spans (watchtron.service = registry name) and the white-box server
    // spans (service.name = expectedServiceName). Filtering by service name here
    // would drop the server spans and break end-to-end correlation.
    const spans = buffer.query({ runId: String(runId) });
    const verdict = verifyRun(spans, { name: serviceName, ...service }, String(runId));
    verdicts.set(serviceName, { ...verdict, at: new Date().toISOString() });
    res.status(verdict.pass ? 200 : 422).json(verdict);
  });

  // --- Shields-compatible badge endpoint ---------------------------------
  // https://img.shields.io/endpoint?url=<this>
  app.get('/badge/:service', (req, res) => {
    const v = verdicts.get(req.params.service);
    let message = 'unknown';
    let color = 'lightgrey';
    if (v) {
      message = v.pass ? 'verified' : 'failing';
      color = v.pass ? 'brightgreen' : 'red';
    }
    res.json({ schemaVersion: 1, label: 'watchtron', message, color });
  });

  // --- Fleet status (JSON for the dashboard) -----------------------------
  app.get('/api/status', (_req, res) => {
    const services = registry.list().map((name) => {
      const v = verdicts.get(name);
      return { name, ...registry.services[name], lastVerdict: v };
    });
    res.json({ services, buffer: buffer.stats() });
  });

  // --- Dashboard ----------------------------------------------------------
  app.use(express.static(join(here, '..', 'public')));

  return app;
}

// Only listen when run directly (lets tests import createApp without a port).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.WATCHTRON_PORT || 4318);
  const token = process.env.WATCHTRON_TOKEN || '';
  const app = createApp({ token });
  app.listen(port, () => {
    console.log(
      `[watchtron] control plane listening on :${port} (token ${token ? 'required' : 'OFF - dev'})`
    );
  });
}
