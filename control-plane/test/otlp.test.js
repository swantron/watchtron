import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOtlpJson } from '../src/otlp.js';

test('flattens OTLP/HTTP JSON into span records', () => {
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'tronswan-web' } }] },
        scopeSpans: [
          {
            scope: { name: 'test' },
            spans: [
              {
                traceId: 'abc',
                spanId: 'def',
                name: 'GET /',
                kind: 2,
                startTimeUnixNano: '1000000',
                endTimeUnixNano: '51000000',
                attributes: [
                  { key: 'synthetic.run_id', value: { stringValue: 'run-9' } },
                  { key: 'http.response.status_code', value: { intValue: '200' } },
                  { key: 'watchtron.role', value: { stringValue: 'server' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const [span] = decodeOtlpJson(body);
  assert.equal(span.serviceName, 'tronswan-web');
  assert.equal(span.statusCode, 200);
  assert.equal(span.role, 'server');
  assert.equal(span.attrs['synthetic.run_id'], 'run-9');
  assert.equal(span.durationMs, 50);
});

test('tolerates empty payloads', () => {
  assert.deepEqual(decodeOtlpJson({}), []);
  assert.deepEqual(decodeOtlpJson({ resourceSpans: [] }), []);
});
