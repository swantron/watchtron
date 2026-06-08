import { request } from 'undici';

/** Build an OTLP KeyValue from a plain JS value. */
function kv(key, value) {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: String(value) } };
}

/**
 * Wrap prober client spans into an OTLP/HTTP JSON ResourceSpans payload.
 * @param {Array<object>} spans Span objects from probe.js
 */
export function buildOtlpPayload(spans) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            kv('service.name', 'watchtron-prober'),
            kv('telemetry.sdk.name', 'watchtron'),
            kv('telemetry.sdk.language', 'nodejs'),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'watchtron-prober', version: '0.1.0' },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              name: s.name,
              kind: 3, // CLIENT
              startTimeUnixNano: s.startNano,
              endTimeUnixNano: s.endNano,
              attributes: Object.entries(s.attrs).map(([k, v]) => kv(k, v)),
              status: { code: s.ok ? 1 : 2 }, // 1=OK, 2=ERROR
            })),
          },
        ],
      },
    ],
  };
}

/**
 * Export spans to a watchtron control plane (OTLP/HTTP JSON).
 * @param {string} endpoint Base URL of the control plane.
 * @param {Array<object>} spans
 * @param {string} [token]
 */
export async function exportSpans(endpoint, spans, token) {
  const payload = buildOtlpPayload(spans);
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await request(`${endpoint.replace(/\/$/, '')}/v1/traces`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  await res.body.text();
  if (res.statusCode >= 400) {
    throw new Error(`OTLP export failed: HTTP ${res.statusCode}`);
  }
  return spans.length;
}
