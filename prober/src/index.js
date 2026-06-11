#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';
import { request } from 'undici';
import { getService } from '@watchtron/registry';
import { probeService } from './probe.js';
import { exportSpans } from './otlp-export.js';
import { newRunId } from './ids.js';

const HELP = `watchtron-probe — drive synthetic traffic and verify it via OpenTelemetry

Usage:
  watchtron-probe --service <name> [options]

Options:
  --service <name>     Registry service to probe (required)
  --base-url <url>     Override the service's registry URL (e.g. a preview deploy)
  --requests <n>       Requests per critical route (overrides the registry; default 3)
  --warmup <n>         Discarded priming requests per route before the measured burst (overrides the registry; default 0)
  --endpoint <url>     Control-plane OTLP endpoint (default $WATCHTRON_OTLP_ENDPOINT or http://localhost:4318)
  --token <token>      Bearer token (default $WATCHTRON_TOKEN)
  --verify             After export, poll /verify and gate exit code on the verdict
  --expect-version <v> Assert the white-box origin serves this version (e.g. the deploy's git SHA)
  --wait <ms>          Max time to wait for telemetry during --verify (overrides the registry; default 30000)
  --strict             Treat an unreachable control plane as a failure (also set per-service via registry failClosed)
  --no-export          Probe only; print local signals and skip OTLP export
  --help               Show this help

Exit codes: 0 = pass (or control plane unreachable, non-strict), 1 = verification
failed (or unreachable + --strict), 2 = usage/setup error

Reachability: if the watchtron control plane can't be reached (so telemetry can
neither be exported nor verified), that's a watchtron outage, not a service
failure — by default the deploy is NOT blocked. Pass --strict (or set
WATCHTRON_STRICT=true) to block on outage instead.`;

function parse() {
  const { values } = parseArgs({
    options: {
      service: { type: 'string' },
      'base-url': { type: 'string' },
      requests: { type: 'string' },
      warmup: { type: 'string' },
      endpoint: { type: 'string' },
      token: { type: 'string' },
      verify: { type: 'boolean', default: false },
      'expect-version': { type: 'string' },
      wait: { type: 'string' },
      strict: { type: 'boolean', default: false },
      'no-export': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  return values;
}

function ghOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function ghSummary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }
}

/**
 * Exit when the control plane itself can't be reached. A watchtron outage must
 * not look like (or block deploys as if it were) a broken service: telemetry
 * couldn't even be exported/queried, so we have no verdict either way. Fail
 * open by default; only block when the caller explicitly opts into --strict.
 */
function exitUnreachable({ serviceName, strict, reason }) {
  const headline = `watchtron control plane unreachable — ${reason}`;
  ghOutput('reachable', 'false');
  ghOutput('pass', strict ? 'false' : 'skipped');
  console.log(
    `::${strict ? 'error' : 'warning'}::${headline}` +
      (strict ? ' (strict mode: failing the deploy gate)' : ' (skipping verify; deploy not blocked)')
  );
  ghSummary(`## watchtron verify — ${serviceName} ⚠️ unreachable`);
  ghSummary('');
  ghSummary(`- ${headline}`);
  ghSummary(
    strict
      ? '- **strict mode**: a control-plane outage fails the deploy gate.'
      : '- a control-plane outage is not a service failure — **not** blocking this deploy.'
  );
  process.exit(strict ? 1 : 0);
}

async function pollVerify({ endpoint, service, runId, token, waitMs, expectVersion }) {
  let url = `${endpoint.replace(/\/$/, '')}/verify?service=${encodeURIComponent(service)}&runId=${encodeURIComponent(runId)}`;
  if (expectVersion) url += `&version=${encodeURIComponent(expectVersion)}`;
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const deadline = Date.now() + waitMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await request(url, { headers });
    last = await res.body.json();
    if (last.pass) return last;
    // Telemetry export is async; give it a beat and retry until the deadline.
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

async function main() {
  const args = parse();
  if (args.help || !args.service) {
    console.log(HELP);
    process.exit(args.help ? 0 : 2);
  }

  const service = getService(args.service);
  const runId = newRunId();
  const endpoint = args.endpoint || process.env.WATCHTRON_OTLP_ENDPOINT || 'http://localhost:4318';
  const token = args.token || process.env.WATCHTRON_TOKEN || '';
  // Precedence for tuning: explicit CLI flag > registry per-service value > default.
  const requestsPerRoute = args.requests ? Number(args.requests) : (service.probe?.requestsPerRoute ?? 3);
  const warmupPerRoute = args.warmup ? Number(args.warmup) : (service.probe?.warmup ?? 0);
  const waitMs = args.wait ? Number(args.wait) : (service.probe?.waitMs ?? 30_000);
  const timeoutMs = service.probe?.timeoutMs ?? 10_000;
  const baseUrl = args['base-url'] || service.url;

  console.log(`[watchtron] probing ${service.name} (${baseUrl}) runId=${runId}`);
  ghOutput('run_id', runId);

  const { spans, signals } = await probeService({
    service,
    runId,
    baseUrl,
    requestsPerRoute,
    warmupPerRoute,
    timeoutMs,
  });

  console.log(
    `[watchtron] ${signals.succeeded}/${signals.total} ok · avail ${signals.availabilityPct}% · p95 ${signals.p95LatencyMs}ms`
  );

  if (args['no-export']) {
    process.exit(0);
  }

  const strict = args.strict || process.env.WATCHTRON_STRICT === 'true' || Boolean(service.failClosed);

  // Export + verify both require the control plane. A transport failure here
  // means watchtron is unreachable (not that the service is broken), so route
  // it to the fail-open handler rather than the generic exit-2 path.
  try {
    await exportSpans(endpoint, spans, token);
  } catch (err) {
    exitUnreachable({
      serviceName: service.name,
      strict,
      reason: `OTLP export failed (${err?.message || err})`,
    });
  }

  console.log(`[watchtron] exported ${spans.length} spans to ${endpoint}`);

  if (!args.verify) {
    process.exit(0);
  }

  const expectVersion = args['expect-version'] || '';

  let verdict;
  try {
    verdict = await pollVerify({
      endpoint,
      service: service.name,
      runId,
      token,
      waitMs,
      expectVersion,
    });
  } catch (err) {
    exitUnreachable({
      serviceName: service.name,
      strict,
      reason: `verify request failed (${err?.message || err})`,
    });
  }

  console.log('[watchtron] verdict:', JSON.stringify(verdict, null, 2));
  ghOutput('pass', verdict?.pass ? 'true' : 'false');

  const icon = verdict?.pass ? '✅' : '❌';
  ghSummary(`## watchtron verify — ${service.name} ${icon}`);
  ghSummary('');
  ghSummary(
    `- availability: **${verdict?.availabilityPct ?? '—'}%** (gate ${service.healthGate.availabilityPct}%)`
  );
  ghSummary(
    `- p95 latency (client, incl. network): **${verdict?.p95LatencyMs ?? '—'}ms** (gate ${service.healthGate.p95LatencyMs}ms)`
  );
  if (verdict?.serverP95LatencyMs != null)
    ghSummary(`- p95 latency (server, app time): **${verdict.serverP95LatencyMs}ms**`);
  const eb = verdict?.errorBreakdown;
  if (eb && (eb.http4xx || eb.http5xx || eb.transport))
    ghSummary(
      `- errors: ${eb.http4xx} client (4xx) · ${eb.http5xx} server (5xx) · ${eb.transport} transport`
    );
  ghSummary(`- routes covered: ${verdict?.routesCovered?.join(', ') || '—'}`);
  if (service.whiteBox)
    ghSummary(`- end-to-end (server span correlated): ${verdict?.endToEnd ? 'yes' : 'no'}`);
  if (expectVersion) {
    const v =
      verdict?.versionMatch === null
        ? `expected ${expectVersion}, origin reported no version (assertion skipped)`
        : `served ${verdict?.servedVersion} ${verdict?.versionMatch ? '==' : '!='} expected ${expectVersion}`;
    ghSummary(`- version: ${v}`);
  }
  if (verdict?.reasons?.length) {
    ghSummary('');
    ghSummary('**failures:**');
    for (const r of verdict.reasons) ghSummary(`- ${r}`);
  }

  process.exit(verdict?.pass ? 0 : 1);
}

main().catch((err) => {
  console.error('[watchtron] error:', err?.message || err);
  process.exit(2);
});
