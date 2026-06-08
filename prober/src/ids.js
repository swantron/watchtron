import { randomBytes, randomUUID } from 'node:crypto';

/** 16-byte trace id as 32 hex chars (W3C / OTLP). */
export const newTraceId = () => randomBytes(16).toString('hex');

/** 8-byte span id as 16 hex chars (W3C / OTLP). */
export const newSpanId = () => randomBytes(8).toString('hex');

/** Stable, human-greppable run id correlating all spans from one probe run. */
export const newRunId = () => randomUUID();

/**
 * Build a W3C traceparent header so white-box services continue this exact
 * trace (their server span becomes a child of the prober's client span).
 * Format: version-traceid-spanid-flags  (flags 01 = sampled).
 */
export const traceparent = (traceId, spanId) => `00-${traceId}-${spanId}-01`;

/** Wall-clock nanoseconds as a string (OTLP timestamps are uint64 nanos). */
export const nowNano = () => (BigInt(Date.now()) * 1_000_000n).toString();

/** start + durationMs expressed as OTLP nanosecond string. */
export const plusMsNano = (startNanoStr, durationMs) =>
  (BigInt(startNanoStr) + BigInt(Math.round(durationMs * 1e6))).toString();
