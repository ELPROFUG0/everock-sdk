import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionPool } from '../src/session-pool.js';

test('counts pending reservations and releases capacity on close', () => {
  const pool = new SessionPool<string>(2, 1);
  assert.equal(pool.reserve('a', 'one', () => 'first', 0), 'first');
  assert.equal(pool.reserve('b', 'one', () => assert.fail(), 0), undefined);
  assert.equal(pool.reserve('b', 'two', () => 'second', 0), 'second');
  assert.equal(pool.reserve('c', 'three', () => assert.fail(), 0), undefined);
  pool.remove('a');
  assert.equal(pool.reserve('c', 'one', () => 'third', 1), 'third');
});

test('only activity by the session owner renews its idle period', () => {
  const pool = new SessionPool<string>(3, 2);
  pool.reserve('a', 'one', () => 'first', 0);
  pool.reserve('b', 'two', () => 'second', 0);
  assert.equal(pool.get('a', 'two', 10), undefined);
  assert.equal(pool.get('b', 'two', 10), 'second');
  assert.deepEqual(pool.expireBefore(5), ['first']);
  assert.equal(pool.get('a', 'one', 15), undefined);
  assert.deepEqual(pool.expireBefore(10), ['second']);
});
