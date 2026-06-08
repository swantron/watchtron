import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Re-export the shared CJS implementation for ESM consumers (e.g. tronswan).
const { start } = require('./bootstrap.cjs');
const { syntheticMarkerMiddleware } = require('./middleware.cjs');

export { start, syntheticMarkerMiddleware };
