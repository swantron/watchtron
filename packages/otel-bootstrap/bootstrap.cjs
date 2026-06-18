'use strict';

/**
 * Core white-box OpenTelemetry bootstrap, shared by the CJS and ESM entry
 * points. Starting tracing is a side effect of requiring this module.
 *
 * Everything is gated on WATCHTRON_OTLP_ENDPOINT: with no endpoint set this is
 * a no-op, so local dev and tests are completely unaffected. When set, the
 * service emits SERVER spans (HTTP + Express) to the watchtron control plane
 * over OTLP/HTTP JSON.
 *
 * We wire the tracer provider by hand instead of pulling in
 * `@opentelemetry/sdk-node`, which bundles every exporter (prometheus, zipkin,
 * grpc, metrics, logs) we don't use -- and the CVEs that ride along with them.
 * watchtron only exports traces, over HTTP, so that is all we install.
 *
 * Service identity comes from WATCHTRON_SERVICE_NAME (must match the registry's
 * expectedServiceName so verify can correlate end-to-end). The W3C trace-context
 * propagator is the load-bearing bit: it lets an incoming `traceparent` (from
 * the watchtron prober) continue into this service's SERVER span, and that
 * shared trace id is exactly what `/verify` matches on. We deliberately do NOT
 * register the baggage propagator -- we don't use it, and skipping it keeps that
 * surface off the build.
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

  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { W3CTraceContextPropagator } = require('@opentelemetry/core');
  const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
  const { registerInstrumentations } = require('@opentelemetry/instrumentation');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');

  const serviceName = process.env.WATCHTRON_SERVICE_NAME || 'unknown-watchtron-service';
  const token = process.env.WATCHTRON_TOKEN;

  const exporter = new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.WATCHTRON_SERVICE_VERSION || '0.0.0',
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  // Register as the global provider with an explicit context manager (so the
  // active span survives async hops) and the W3C trace-context propagator (so
  // the prober's traceparent is extracted and this server span joins its trace).
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  provider.register({
    contextManager,
    propagator: new W3CTraceContextPropagator(),
  });

  registerInstrumentations({
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
  });

  const shutdown = () => {
    provider.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[watchtron] white-box tracing started for "${serviceName}" -> ${endpoint}`);
}

start();

module.exports = { start };
