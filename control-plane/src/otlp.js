/**
 * Minimal OTLP/HTTP JSON decoder.
 *
 * We accept the OTLP "ResourceSpans" JSON shape (what an OTLP/HTTP exporter
 * sends when OTEL_EXPORTER_OTLP_PROTOCOL=http/json) and flatten it into simple
 * span records the buffer and verifier can reason about. Sticking to JSON means
 * the receiver needs zero protobuf dependencies.
 *
 * @typedef {object} SpanRecord
 * @property {string} traceId
 * @property {string} spanId
 * @property {string} parentSpanId
 * @property {string} name
 * @property {number} kind            OTLP SpanKind enum (2=SERVER, 3=CLIENT)
 * @property {number} startNano
 * @property {number} endNano
 * @property {number} durationMs
 * @property {string} serviceName     from resource attribute service.name
 * @property {string} [watchtronService] from span attribute watchtron.service
 * @property {string} [role]          watchtron.role: "prober" | "server"
 * @property {number|null} statusCode HTTP status if present
 * @property {Record<string, any>} attrs flattened span attributes
 * @property {number} receivedAt      ms epoch when the control plane ingested it
 */

/** Unwrap an OTLP AnyValue into a plain JS value. */
function anyValue(v) {
  if (v == null) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(anyValue);
  return undefined;
}

/** Turn an OTLP KeyValue[] into a flat object. */
function attrsToObject(kvs = []) {
  const out = {};
  for (const kv of kvs) out[kv.key] = anyValue(kv.value);
  return out;
}

const HTTP_STATUS_KEYS = ['http.response.status_code', 'http.status_code'];

/**
 * Flatten an OTLP/HTTP JSON payload into SpanRecord[].
 * @param {any} body Parsed JSON request body.
 * @returns {SpanRecord[]}
 */
export function decodeOtlpJson(body) {
  const now = Date.now();
  const out = [];
  const resourceSpans = body?.resourceSpans || [];
  for (const rs of resourceSpans) {
    const resourceAttrs = attrsToObject(rs.resource?.attributes);
    const serviceName = resourceAttrs['service.name'] || 'unknown';
    for (const ss of rs.scopeSpans || []) {
      for (const span of ss.spans || []) {
        const attrs = attrsToObject(span.attributes);
        let statusCode = null;
        for (const k of HTTP_STATUS_KEYS) {
          if (attrs[k] != null) {
            statusCode = Number(attrs[k]);
            break;
          }
        }
        const startNano = Number(span.startTimeUnixNano || 0);
        const endNano = Number(span.endTimeUnixNano || 0);
        out.push({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId || '',
          name: span.name,
          kind: span.kind ?? 0,
          startNano,
          endNano,
          durationMs: endNano > startNano ? (endNano - startNano) / 1e6 : 0,
          serviceName,
          watchtronService: attrs['watchtron.service'],
          role: attrs['watchtron.role'],
          statusCode,
          attrs,
          receivedAt: now,
        });
      }
    }
  }
  return out;
}
