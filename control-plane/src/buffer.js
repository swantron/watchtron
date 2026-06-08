/**
 * Ephemeral in-memory span store.
 *
 * By design this is NOT durable: spans only need to survive the seconds between
 * synthetic traffic being generated and the verify step polling for it. The
 * control plane runs on an always-on GCE e2-micro so the process (and this
 * buffer) stay warm; we never rely on it across restarts.
 *
 * It is a bounded ring buffer plus a time-based eviction so memory stays flat
 * on a tiny VM regardless of traffic.
 */
export class SpanBuffer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSpans] Hard cap on retained spans (ring eviction).
   * @param {number} [opts.ttlMs] Spans older than this (by receivedAt) are dropped.
   */
  constructor({ maxSpans = 50_000, ttlMs = 15 * 60 * 1000 } = {}) {
    this.maxSpans = maxSpans;
    this.ttlMs = ttlMs;
    /** @type {import('./otlp.js').SpanRecord[]} */
    this.spans = [];
  }

  /** @param {import('./otlp.js').SpanRecord[]} records */
  add(records) {
    for (const r of records) this.spans.push(r);
    this.#evict();
  }

  #evict() {
    const cutoff = Date.now() - this.ttlMs;
    if (this.spans.length && this.spans[0].receivedAt < cutoff) {
      this.spans = this.spans.filter((s) => s.receivedAt >= cutoff);
    }
    if (this.spans.length > this.maxSpans) {
      this.spans = this.spans.slice(this.spans.length - this.maxSpans);
    }
  }

  /**
   * Query spans, optionally filtered by run id and/or service.
   * @param {{ runId?: string, service?: string, sinceMs?: number }} [filter]
   */
  query({ runId, service, sinceMs } = {}) {
    this.#evict();
    const since = sinceMs ? Date.now() - sinceMs : 0;
    return this.spans.filter((s) => {
      if (runId && s.attrs['synthetic.run_id'] !== runId) return false;
      if (service && s.watchtronService !== service && s.serviceName !== service) return false;
      if (since && s.receivedAt < since) return false;
      return true;
    });
  }

  get size() {
    return this.spans.length;
  }

  stats() {
    this.#evict();
    const byService = {};
    for (const s of this.spans) {
      const key = s.watchtronService || s.serviceName || 'unknown';
      byService[key] = (byService[key] || 0) + 1;
    }
    return { total: this.spans.length, byService };
  }
}
