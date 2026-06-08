'use strict';
// CJS entry: `require('@swantron/otel-bootstrap/register')` as the FIRST line
// of a CommonJS service (e.g. chomptron) so instrumentation patches modules
// before express/http are required.
require('./bootstrap.cjs');
