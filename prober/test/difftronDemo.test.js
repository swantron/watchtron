import { test } from 'node:test';
import assert from 'node:assert/strict';
import { covered } from '../src/difftronDemo.js';

test('difftronDemo covered() adds', () => {
  assert.equal(covered(2, 3), 5);
});
