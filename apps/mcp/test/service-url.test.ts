import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serviceUrl } from '../src/service-url.js';

test('accepts TLS and loopback development URLs and preserves service prefixes', () => {
  for (const url of ['https://api.example.test/internal', 'http://localhost:4000', 'http://127.0.0.1', 'http://[::1]:4000']) {
    assert.equal(serviceUrl(url + '/'), url);
  }
});

test('rejects insecure remote destinations and URL components inappropriate for a service base', () => {
  for (const url of ['http://api.example.test', 'ftp://localhost', 'https://user:password@example.test', 'https://example.test/?key=test', 'https://example.test/#fragment']) {
    assert.throws(() => serviceUrl(url));
  }
});
