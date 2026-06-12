/**
 * Persisted per-service verification history -- the data behind "deploy markers"
 * on the blended uptime timeline. Each /verify appends a compact record so the
 * dashboards can plot when verified deploys happened (and whether they passed)
 * against uptime-monitor's continuous uptime series.
 *
 * Same durability contract as the verdict / baseline stores: a bounded ring per
 * service, mirrored to disk via atomic temp-write+rename.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class HistoryStore {
  /** @param {object} [opts] @param {string} [opts.file] @param {number} [opts.cap] entries kept per service */
  constructor({ file, cap = 50 } = {}) {
    this.file = file || null;
    this.cap = cap;
    /** @type {Map<string, Array<{at:string,pass:boolean,p95:number,version:string|null}>>} */
    this.map = new Map();
    if (this.file) this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) this.map.set(k, v);
    } catch (err) {
      console.warn(`[watchtron] could not load history store (${this.file}): ${err?.message || err}`);
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
      console.warn(`[watchtron] could not persist history store (${this.file}): ${err?.message || err}`);
    }
  }

  /** Recent records for a service (a copy; oldest first). */
  list(service) {
    const arr = this.map.get(service);
    return arr ? [...arr] : [];
  }

  /** Append a verification record, capped to the ring. */
  record(service, { at, pass, p95, version }) {
    const arr = this.map.get(service) || [];
    arr.push({ at, pass: !!pass, p95, version: version || null });
    while (arr.length > this.cap) arr.shift();
    this.map.set(service, arr);
    this.#persist();
  }
}
