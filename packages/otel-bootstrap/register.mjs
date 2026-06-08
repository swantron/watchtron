// ESM entry: start via `node --import @swantron/otel-bootstrap/register server.js`
// (e.g. tronswan) so the SDK starts before the app's modules are imported.
// ESM can import the shared CJS core directly.
import './bootstrap.cjs';
