# Changelog

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
