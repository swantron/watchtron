'use strict';
const { start } = require('./bootstrap.cjs');
const { syntheticMarkerMiddleware } = require('./middleware.cjs');
module.exports = { start, syntheticMarkerMiddleware };
