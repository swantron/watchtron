# @swantron/otel-bootstrap

Drop-in OpenTelemetry bootstrap for **white-box** watchtron services. Emits HTTP +
Express SERVER spans to the watchtron control plane over OTLP/HTTP JSON, and
stamps synthetic run ids onto spans so the control plane can confirm real
end-to-end traffic.

Ships **dual CJS + ESM** because the fleet has both: chomptron is CommonJS,
tronswan is ESM.

## Install

```bash
npm install @swantron/otel-bootstrap
```

## Publishing (automated via CI, no token)

Publishing happens in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml):
on every push to `main`, after tests pass, the `publish-otel-bootstrap` job
publishes this package to public npm — but only when the version in
`package.json` is not already on the registry (idempotent).

Auth uses **npm OIDC Trusted Publishing** — short-lived credentials minted per
run via GitHub's `id-token`, so there is **no `NPM_TOKEN` secret to store or
rotate**. Provenance is attached automatically.

To cut a release: bump `version` here and merge to `main`. Consumer repos pin `^0.1.0`.

### One-time setup (bootstrap)

Trusted publishing is configured per package, so the package must exist first:

1. Publish v0.1.0 once, locally, with browser auth (no token):
   ```bash
   npm login                       # web-based, no token
   cd packages/otel-bootstrap
   npm publish --access public     # @swantron scope; no org needed
   ```
2. On npmjs.com, open the package → **Settings → Trusted Publisher** → add a
   GitHub Actions publisher: repository `swantron/watchtron`, workflow `ci.yml`.

After that, all future version bumps publish automatically via CI with zero secrets.

## Activation is env-gated

Nothing happens unless `WATCHTRON_OTLP_ENDPOINT` is set, so local dev and tests
are unaffected. Required runtime env on the deployed service:

| Env                       | Value                                         |
| ------------------------- | --------------------------------------------- |
| `WATCHTRON_OTLP_ENDPOINT` | `https://watch.swantron.com`                  |
| `WATCHTRON_TOKEN`         | the control-plane bearer token                |
| `WATCHTRON_SERVICE_NAME`  | must equal the registry `expectedServiceName` |

## ESM service (tronswan)

Start the SDK before the app loads via `--import`:

```jsonc
// package.json
"start": "node --import @swantron/otel-bootstrap/register server.js"
```

Then add the synthetic-marker middleware early in the Express chain:

```js
import { syntheticMarkerMiddleware } from '@swantron/otel-bootstrap';
app.use(syntheticMarkerMiddleware());
```

## CommonJS service (chomptron)

Require the bootstrap as the **very first line** of `server.js` (before `express`
is required) so instrumentation can patch modules:

```js
require('@swantron/otel-bootstrap/register');
const express = require('express');
const { syntheticMarkerMiddleware } = require('@swantron/otel-bootstrap');
// ...
app.use(syntheticMarkerMiddleware());
```
