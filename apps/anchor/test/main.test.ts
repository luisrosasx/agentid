import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, concat, toUtf8Bytes } from 'ethers';
import { app, merkleRoot, MAX_BATCH } from '../src/main.ts';

test('healthz', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, service: 'anchor' });
});

test('merkle root is deterministic and order-sensitive', () => {
  const a = ['0xaa', '0xbb'].map((x) => keccak256(x)) as unknown as `0x${string}`[];
  const b = ['0xaa', '0xbb'].map((x) => keccak256(x)) as unknown as `0x${string}`[];
  assert.equal(merkleRoot(a), merkleRoot(b));
  const swapped = ['0xbb', '0xaa'].map((x) => keccak256(x)) as unknown as `0x${string}`[];
  assert.notEqual(merkleRoot(a), merkleRoot(swapped));
});

test('odd leaf count duplicates last leaf', () => {
  const one = [keccak256(toUtf8Bytes('a'))] as unknown as `0x${string}`[];
  const expected = keccak256(concat([keccak256(toUtf8Bytes('a')), keccak256(toUtf8Bytes('a'))]));
  assert.equal(merkleRoot(one), expected);
});

test('anchors a batch', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/anchor',
    payload: { attestations: [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }] },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.mode, 'sim');
  assert.equal(body.leafCount, 3);
  assert.match(body.txHash, /^0x[0-9a-f]{64}$/);
  assert.match(body.root, /^0x[0-9a-f]{64}$/);
});

test('rejects empty and oversized batches', async () => {
  const empty = await app.inject({ method: 'POST', url: '/anchor', payload: { attestations: [] } });
  assert.equal(empty.statusCode, 400);
  const big = await app.inject({ method: 'POST', url: '/anchor', payload: { attestations: Array(MAX_BATCH + 1).fill({}) } });
  assert.equal(big.statusCode, 413);
});
