'use strict';

const { trace } = require('@opentelemetry/api');

/**
 * Express middleware that stamps watchtron synthetic markers onto the active
 * SERVER span. This is what lets the control plane correlate prober traffic
 * with the origin's own span and confirm a request truly reached this service
 * (not just an edge cache).
 *
 * @param {object} [opts]
 * @param {string} [opts.service] Logical service name (defaults to WATCHTRON_SERVICE_NAME).
 */
function syntheticMarkerMiddleware(opts = {}) {
  const service = opts.service || process.env.WATCHTRON_SERVICE_NAME;
  return function watchtronSyntheticMarker(req, res, next) {
    const runId = req.headers['x-synthetic-run-id'];
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttribute('watchtron.role', 'server');
      if (service) span.setAttribute('watchtron.service', service);
      if (runId) {
        span.setAttribute('synthetic.run_id', String(runId));
        span.setAttribute('synthetic', true);
      }
    }
    next();
  };
}

module.exports = { syntheticMarkerMiddleware };
