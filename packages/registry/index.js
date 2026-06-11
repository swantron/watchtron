import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));

// The registry lives at <repo>/registry/services.yaml. packages/registry is two
// levels deep, so walk up to the repo root. WATCHTRON_REGISTRY overrides it
// (handy for tests and ad-hoc fleets).
const DEFAULT_REGISTRY_PATH = process.env.WATCHTRON_REGISTRY || resolve(here, '../../registry/services.yaml');

const REQUIRED_FIELDS = ['url', 'whiteBox', 'mode', 'criticalRoutes', 'healthGate'];
const VALID_MODES = new Set(['post-deploy', 'schedule']);

/**
 * Validate a single service entry, throwing with an actionable message.
 * @param {string} name
 * @param {Record<string, unknown>} svc
 */
function validateService(name, svc) {
  for (const field of REQUIRED_FIELDS) {
    if (svc[field] === undefined) {
      throw new Error(`registry: service "${name}" is missing required field "${field}"`);
    }
  }
  if (!VALID_MODES.has(svc.mode)) {
    throw new Error(
      `registry: service "${name}" has invalid mode "${svc.mode}" (expected one of: ${[...VALID_MODES].join(', ')})`
    );
  }
  if (!Array.isArray(svc.criticalRoutes) || svc.criticalRoutes.length === 0) {
    throw new Error(`registry: service "${name}" must list at least one criticalRoutes entry`);
  }
  if (svc.whiteBox && !svc.expectedServiceName) {
    throw new Error(
      `registry: white-box service "${name}" must declare expectedServiceName (the service.name its server reports)`
    );
  }
  const { healthGate } = svc;
  if (typeof healthGate.availabilityPct !== 'number' || typeof healthGate.p95LatencyMs !== 'number') {
    throw new Error(
      `registry: service "${name}" healthGate must define numeric availabilityPct and p95LatencyMs`
    );
  }
  if (healthGate.serverP95LatencyMs !== undefined && typeof healthGate.serverP95LatencyMs !== 'number') {
    throw new Error(`registry: service "${name}" healthGate.serverP95LatencyMs must be a number`);
  }
  // Optional per-service tuning (the prober falls back to global defaults, and
  // an explicit CLI flag overrides both).
  if (svc.probe !== undefined) {
    for (const key of ['requestsPerRoute', 'timeoutMs', 'waitMs', 'warmup']) {
      if (svc.probe[key] !== undefined && typeof svc.probe[key] !== 'number') {
        throw new Error(`registry: service "${name}" probe.${key} must be a number`);
      }
    }
  }
  if (svc.failClosed !== undefined && typeof svc.failClosed !== 'boolean') {
    throw new Error(`registry: service "${name}" failClosed must be a boolean`);
  }
}

/**
 * Load and validate the registry.
 * @param {string} [path] Optional override path to a services.yaml file.
 * @returns {{ services: Record<string, any>, list: () => string[] }}
 */
export function loadRegistry(path = DEFAULT_REGISTRY_PATH) {
  const raw = readFileSync(path, 'utf8');
  const doc = parse(raw);
  if (!doc || typeof doc.services !== 'object') {
    throw new Error(`registry: ${path} must contain a top-level "services" map`);
  }
  for (const [name, svc] of Object.entries(doc.services)) {
    validateService(name, svc);
  }
  return {
    services: doc.services,
    list: () => Object.keys(doc.services),
  };
}

/**
 * Resolve a single service by name (validated).
 * @param {string} name
 * @param {string} [path]
 */
export function getService(name, path = DEFAULT_REGISTRY_PATH) {
  const { services } = loadRegistry(path);
  const svc = services[name];
  if (!svc) {
    const known = Object.keys(services).join(', ');
    throw new Error(`registry: unknown service "${name}". Known services: ${known}`);
  }
  return { name, ...svc };
}

export { DEFAULT_REGISTRY_PATH };
