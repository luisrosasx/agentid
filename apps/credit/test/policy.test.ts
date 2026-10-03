import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_LIMIT_WEI, computePolicy, DEFAULT_SCORE, fetchScore } from '../src/policy.js';

test('computePolicy scales the 1 ETH base limit linearly with score', () => {
  const p50 = computePolicy('a1', 50, 'default');
  assert.equal(p50.dailyLimitWei, (BASE_LIMIT_WEI / 2n).toString());
  const p100 = computePolicy('a1', 100, 'pob');
  assert.equal(p100.dailyLimitWei, BASE_LIMIT_WEI.toString());
  const p0 = computePolicy('a1', 0, 'pob');
  assert.equal(p0.dailyLimitWei, '1'); // minimum 1 wei
});

test('policy always requires human review and has no auto-allowed targets', () => {
  const p = computePolicy('a1', 80, 'pob');
  assert.equal(p.underwriting, 'human-review-required');
  assert.deepEqual(p.allowedTargets, []);
  assert.equal(p.policyVersion, '1.0.0');
});

test('policy is deterministic for the same inputs', () => {
  assert.deepEqual(computePolicy('a1', 50, 'default'), computePolicy('a1', 50, 'default'));
});

test('fetchScore falls back to the default score without POB_URL', async () => {
  const r = await fetchScore(undefined, 'a1');
  assert.equal(r.score, DEFAULT_SCORE);
  assert.equal(r.source, 'default');
});

test('fetchScore falls back when the PoB endpoint is unreachable', async () => {
  const r = await fetchScore('http://127.0.0.1:1', 'a1');
  assert.equal(r.score, DEFAULT_SCORE);
  assert.equal(r.source, 'default');
});
