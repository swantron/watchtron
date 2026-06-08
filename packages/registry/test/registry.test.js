import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, getService } from '../index.js';

test('loads and validates the real fleet registry', () => {
  const { services, list } = loadRegistry();
  const names = list();
  assert.equal(names.length, 6);
  for (const expected of ['tronswan', 'chomptron', 'swantron', 'mt', 'wrenchtron', 'jswan.dev']) {
    assert.ok(names.includes(expected), `registry missing ${expected}`);
  }
  // White-box services must declare an expectedServiceName.
  assert.equal(services.tronswan.expectedServiceName, 'tronswan-web');
  assert.equal(services.chomptron.expectedServiceName, 'chomptron-web');
});

test('getService throws helpfully for unknown service', () => {
  assert.throws(() => getService('nope'), /unknown service "nope"/);
});

test('getService returns a named entry', () => {
  const svc = getService('mt');
  assert.equal(svc.name, 'mt');
  assert.equal(svc.whiteBox, false);
});
