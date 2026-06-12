import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { HistoryStore } from '../src/history-store.js';

test('records pass and fail entries, capped and persisted', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wt-hist-')), 'history.json');
  const a = new HistoryStore({ file, cap: 3 });
  a.record('svc', { at: 't1', pass: true, p95: 100, version: 'abc' });
  a.record('svc', { at: 't2', pass: false, p95: 5000, version: null });
  a.record('svc', { at: 't3', pass: true, p95: 110, version: 'def' });
  a.record('svc', { at: 't4', pass: true, p95: 120, version: 'ghi' });

  const list = a.list('svc');
  assert.equal(list.length, 3); // t1 evicted by the cap
  assert.deepEqual(
    list.map((e) => e.at),
    ['t2', 't3', 't4']
  );
  assert.equal(list[0].pass, false); // fail entries are retained (they become markers)

  const b = new HistoryStore({ file, cap: 3 });
  assert.deepEqual(
    b.list('svc').map((e) => e.at),
    ['t2', 't3', 't4']
  ); // survived reload
  assert.deepEqual(b.list('absent'), []);
});

test('normalizes a missing version to null', () => {
  const h = new HistoryStore();
  h.record('svc', { at: 't1', pass: true, p95: 100, version: undefined });
  assert.equal(h.list('svc')[0].version, null);
});
