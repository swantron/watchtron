/**
 * Persisted rolling p95 history per service, feeding regression detection.
 *
 * Same durability contract as the verdict store: a bounded window per service,
 * mirrored to disk via atomic temp-write+rename so it survives control-plane
 * restarts (the regression baseline would otherwise reset on every deploy).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class BaselineStore {
  /** @param {object} [opts] @param {string} [opts.file] @param {number} [opts.window] samples kept per service */
  constructor({ file, window = 20 } = {}) {
    this.file = file || null;
    this.window = window;
    /** @type {Map<string, number[]>} */
    this.map = new Map();
    if (this.file) this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) this.map.set(k, v);
    } catch (err) {
      console.warn(`[watchtron] could not load baseline store (${this.file}): ${err?.message || err}`);
    }
  }

  #persist() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[watchtron] could not persist baseline store (${this.file}): ${err?.message || err}`);
    }
  }

  /** Prior samples for a service (a copy; most recent last). Excludes the current run. */
  samples(service) {
    const arr = this.map.get(service);
    return arr ? [...arr] : [];
  }

  /** Append a p95 sample, capped to the rolling window. */
  record(service, p95) {
    const arr = this.map.get(service) || [];
    arr.push(p95);
    while (arr.length > this.window) arr.shift();
    this.map.set(service, arr);
    this.#persist();
  }
}
