import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTraceId, newSpanId, traceparent, nowNano, plusMsNano } from '../src/ids.js';

test('trace and span ids are correctly sized hex', () => {
  assert.match(newTraceId(), /^[0-9a-f]{32}$/);
  assert.match(newSpanId(), /^[0-9a-f]{16}$/);
});

test('traceparent is W3C formatted and sampled', () => {
  const tp = traceparent('a'.repeat(32), 'b'.repeat(16));
  assert.equal(tp, `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
});

test('plusMsNano advances the timestamp by the right number of nanos', () => {
  const start = nowNano();
  const end = plusMsNano(start, 50);
  assert.equal(BigInt(end) - BigInt(start), 50_000_000n);
});
