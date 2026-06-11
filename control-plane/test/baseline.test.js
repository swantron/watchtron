import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { median, assessRegression } from '../src/baseline.js';
import { BaselineStore } from '../src/baseline-store.js';

test('median handles odd and even length', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), 0);
});

test('assessRegression withholds judgment until minSamples', () => {
  const r = assessRegression(500, [100, 100], { minSamples: 5 });
  assert.equal(r.regressed, false);
  assert.equal(r.baselineP95, null);
  assert.equal(r.samples, 2);
});

test('assessRegression flags a p95 well above the baseline', () => {
  const prior = [100, 100, 110, 90, 100]; // median 100
  const r = assessRegression(300, prior, { tolerancePct: 50 });
  assert.equal(r.baselineP95, 100);
  assert.equal(r.regressionPct, 200);
  assert.equal(r.regressed, true);
});

test('assessRegression stays calm within tolerance', () => {
  const r = assessRegression(120, [100, 100, 110, 90, 100], { tolerancePct: 50 });
  assert.equal(r.regressionPct, 20);
  assert.equal(r.regressed, false);
});

test('BaselineStore caps the rolling window and persists across reloads', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wt-base-')), 'baselines.json');
  const a = new BaselineStore({ file, window: 3 });
  for (const v of [10, 20, 30, 40]) a.record('svc', v);
  assert.deepEqual(a.samples('svc'), [20, 30, 40]); // 10 evicted by the window

  const b = new BaselineStore({ file, window: 3 });
  assert.deepEqual(b.samples('svc'), [20, 30, 40]); // survived reload
  assert.deepEqual(b.samples('absent'), []);
});
