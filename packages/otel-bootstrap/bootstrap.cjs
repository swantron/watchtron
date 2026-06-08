'use strict';

/**
 * Core white-box OpenTelemetry bootstrap, shared by the CJS and ESM entry
 * points. Starting the SDK is a side effect of requiring this module.
 *
 * Everything is gated on WATCHTRON_OTLP_ENDPOINT: with no endpoint set this is
 * a no-op, so local dev and tests are completely unaffected. When set, the
 * service emits SERVER spans (HTTP + Express) to the watchtron control plane
 * over OTLP/HTTP JSON.
 *
 * Service identity comes from WATCHTRON_SERVICE_NAME (must match the registry's
 * expectedServiceName for that service so verify can correlate end-to-end).
 */

let started = false;

function start() {
  if (started) return;
  started = true;

  const endpoint = process.env.WATCHTRON_OTLP_ENDPOINT;
  if (!endpoint) {
    // Intentionally silent-ish: no backend configured, nothing to do.
    return;
  }

  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');

  const serviceName = process.env.WATCHTRON_SERVICE_NAME || 'unknown-watchtron-service';
  const token = process.env.WATCHTRON_TOKEN;

  const exporter = new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.WATCHTRON_SERVICE_VERSION || '0.0.0',
    }),
    traceExporter: exporter,
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
  });

  sdk.start();

  const shutdown = () => {
    sdk.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[watchtron] white-box tracing started for "${serviceName}" -> ${endpoint}`);
}

start();

module.exports = { start };
