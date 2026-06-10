/**
 * Durable last-verdict store.
 *
 * The span buffer is ephemeral by design, but the per-service verdicts that the
 * dashboard and /badge endpoints render must survive a process restart --
 * otherwise every `deploy-control-plane` run (which does `systemctl restart`)
 * resets all badges to grey "unknown" until each service next deploys.
 *
 * This is a tiny key/value map mirrored to a JSON file. Writes are atomic
 * (temp file + rename) so a crash mid-write can't corrupt the store, and load
 * failures degrade gracefully to an empty store rather than crashing boot.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class VerdictStore {
  /** @param {object} [opts] @param {string} [opts.file] JSON path to persist to (omit for in-memory only). */
  constructor({ file } = {}) {
    this.file = file || null;
    /** @type {Map<string, object>} */
    this.map = new Map();
    if (this.file) this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(data)) this.map.set(k, v);
    } catch (err) {
      console.warn(`[watchtron] could not load verdict store (${this.file}): ${err?.message || err}`);
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
      console.warn(`[watchtron] could not persist verdict store (${this.file}): ${err?.message || err}`);
    }
  }

  /** @param {string} service @param {object} verdict */
  set(service, verdict) {
    this.map.set(service, verdict);
    this.#persist();
  }

  /** @param {string} service @returns {object|null} */
  get(service) {
    return this.map.get(service) || null;
  }
}
