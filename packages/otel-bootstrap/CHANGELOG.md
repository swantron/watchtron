# Changelog

## 0.1.2

- **Export spans with `SimpleSpanProcessor` instead of `BatchSpanProcessor`.** On
  a scale-to-zero serverless host (Cloud Run), the batch processor's background
  flush timer stalls once the container is CPU-throttled after a request burst,
  so server spans never reach the collector before watchtron's `/verify` window
  closes (white-box `endToEnd` correlation silently fails). Per-span export fires
  while the request is still in flight and CPU is available. These are tiny,
  low-traffic services, so the cost is negligible.
- **Stop tracing outgoing requests** (`ignoreOutgoingRequestHook: () => true`).
  watchtron only needs the inbound SERVER span; suppressing CLIENT spans also
  prevents an export feedback loop, where each OTLP export POST would itself be
  traced and exported — fatal under per-span export.

## 0.1.1

- **Drop `@opentelemetry/sdk-node`** for a hand-wired `NodeTracerProvider` +
  OTLP/HTTP trace exporter + HTTP/Express instrumentations. This removes the
  bundled exporters watchtron never uses (Prometheus, Zipkin, gRPC,
  OTLP-gRPC/proto) and the CVE classes that ride along with them.
- **Bump the OpenTelemetry dependencies** to the current release train, clearing
  all known advisories (`npm audit` is clean).
- Register **only** the W3C trace-context propagator (no baggage). End-to-end
  trace correlation is preserved; the baggage surface is dropped.

## 0.1.0

- Initial release: drop-in white-box OpenTelemetry bootstrap (dual CJS + ESM)
  plus the synthetic-run-id Express middleware for watchtron services.
