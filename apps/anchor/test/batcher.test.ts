import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  merkleRootFromLeaves,
  merkleProofFromLeaves,
  verifyMerkleProof,
} from '@cardca/sdk-receipts';
import {
  claimPendingLeaves,
  runBatchCycle,
  simAnchorFn,
  batcherEnabled,
  startBatcher,
  ensurePendingLeavesTable,
  MAX_ATTEMPTS,
  type BatchCycleResult,
} from '../src/batcher.ts';
import { FakeDb } from './fakedb.ts';

async function seedLeaves(db: FakeDb, n: number, prefix = 'leaf'): Promise<string[]> {
  const hashes: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = keccak256(toUtf8Bytes(`${prefix}:${i}`));
    await db.query(`INSERT INTO pending_leaves (agent_id, leaf_hash) VALUES ($1, $2) RETURNING id`, ['a', h]);
    hashes.push(h);
  }
  return hashes;
}

test('ensurePendingLeavesTable ejecuta el DDL sin error', async () => {
  const db = new FakeDb();
  await assert.doesNotReject(() => ensurePendingLeavesTable(db));
});

test('claim es atómico: pending → anchoring y no repite hojas', async () => {
  const db = new FakeDb();
  const hashes = await seedLeaves(db, 3);
  const claimed = await claimPendingLeaves(db, 10);
  assert.equal(claimed.length, 3);
  assert.deepEqual(claimed.map((c) => c.leafHash).sort(), [...hashes].sort());
  assert.ok(claimed.every((c) => c.attempts === 1));
  // ya no hay pendientes
  const again = await claimPendingLeaves(db, 10);
  assert.equal(again.length, 0);
  // respetar límite de tamaño
  const db2 = new FakeDb();
  await seedLeaves(db2, 5);
  const partial = await claimPendingLeaves(db2, 2);
  assert.equal(partial.length, 2);
});

test('runBatchCycle construye el root Merkle correcto y marca anchored con txHash real', async () => {
  const db = new FakeDb();
  const hashes = await seedLeaves(db, 4);
  const expectedRoot = merkleRootFromLeaves(hashes);
  let calledWith: string | null = null;
  const result = await runBatchCycle(db, async (root) => {
    calledWith = root;
    return { txHash: '0x' + 'cc'.repeat(32), blockNumber: 42 };
  }, 50, 'sim');
  assert.ok(result);
  assert.equal(calledWith, expectedRoot);
  assert.equal(result.root, expectedRoot);
  assert.equal(result.txHash, '0x' + 'cc'.repeat(32));
  assert.equal(result.blockNumber, 42);
  for (const l of db.leaves) {
    assert.equal(l.status, 'anchored');
    assert.equal(l.tx_hash, '0x' + 'cc'.repeat(32));
    assert.equal(l.block_number, 42);
    assert.equal(l.batch_id, BigInt(result.batchId));
  }
  const proof = verifyMerkleProof(hashes[1], merkleProofFromLeaves(hashes, hashes[1])!, expectedRoot);
  assert.equal(proof, true);
});

test('runBatchCycle sin pendientes devuelve null', async () => {
  const db = new FakeDb();
  const result = await runBatchCycle(db, simAnchorFn(), 50, 'sim');
  assert.equal(result, null);
});

test('fallo de tx → status failed con backoff y reintento; max 5 attempts', async () => {
  const db = new FakeDb();
  await seedLeaves(db, 2);
  const counters = { batchesAnchored: 0, anchorFailures: 0 };
  let calls = 0;
  const failing = async (): Promise<{ txHash: string; blockNumber: number | null }> => {
    calls += 1;
    throw new Error('rpc down');
  };
  await assert.rejects(() => runBatchCycle(db, failing, 50, 'real', counters));
  assert.equal(counters.anchorFailures, 1);
  assert.ok(db.leaves.every((l) => l.status === 'failed' && l.attempts === 1 && l.next_retry_at !== null));

  // sin next_retry_at vencido aún no se reclama
  const notYet = await claimPendingLeaves(db, 10);
  // (FakeDb: next_retry_at en el futuro → no elegible)
  assert.equal(notYet.length, 0);

  // simulamos vencimiento del backoff
  for (const l of db.leaves) l.next_retry_at = new Date(Date.now() - 1000);
  // reintento fallido hasta agotar MAX_ATTEMPTS
  for (let i = 2; i <= MAX_ATTEMPTS; i++) {
    for (const l of db.leaves) l.next_retry_at = new Date(Date.now() - 1000);
    await assert.rejects(() => runBatchCycle(db, failing, 50, 'real', counters));
  }
  assert.equal(counters.anchorFailures, MAX_ATTEMPTS);
  assert.ok(db.leaves.every((l) => l.attempts === MAX_ATTEMPTS && l.next_retry_at === null));
  // agotado: ya no se reclama ni reintenta
  for (const l of db.leaves) l.next_retry_at = new Date(Date.now() - 1000);
  const drained = await claimPendingLeaves(db, 10);
  assert.equal(drained.length, 0);
  assert.equal(calls, MAX_ATTEMPTS);
});

test('recuperación: falla y luego el siguiente ciclo ancla', async () => {
  const db = new FakeDb();
  await seedLeaves(db, 2);
  let shouldFail = true;
  const flaky = async (): Promise<{ txHash: string; blockNumber: number | null }> => {
    if (shouldFail) throw new Error('boom');
    return { txHash: '0x' + '11'.repeat(32), blockNumber: 7 };
  };
  await assert.rejects(() => runBatchCycle(db, flaky, 50, 'real'));
  for (const l of db.leaves) l.next_retry_at = new Date(Date.now() - 1000);
  shouldFail = false;
  const ok = await runBatchCycle(db, flaky, 50, 'real');
  assert.ok(ok);
  assert.equal(ok.txHash, '0x' + '11'.repeat(32));
  assert.ok(db.leaves.every((l) => l.status === 'anchored'));
});

test('idempotencia: mismo root no duplica ancla (ON CONFLICT root)', async () => {
  const db = new FakeDb();
  const hashes = await seedLeaves(db, 2);
  await runBatchCycle(db, simAnchorFn('x'), 50, 'sim');
  // mismas hojas, nuevo ciclo: root idéntico → reutiliza el anchor existente
  for (const h of hashes) {
    await db.query(`INSERT INTO pending_leaves (agent_id, leaf_hash) VALUES ($1, $2) RETURNING id`, ['a', h]);
  }
  const second = await runBatchCycle(db, simAnchorFn('x'), 50, 'sim');
  assert.ok(second);
  assert.equal(db.anchors.length, 1);
});

test('dedupe de hojas repetidas dentro del ciclo', async () => {
  const db = new FakeDb();
  const h = keccak256(toUtf8Bytes('dup'));
  await db.query(`INSERT INTO pending_leaves (agent_id, leaf_hash) VALUES ($1, $2) RETURNING id`, ['a', h]);
  await db.query(`INSERT INTO pending_leaves (agent_id, leaf_hash) VALUES ($1, $2) RETURNING id`, ['a', h]);
  const result = await runBatchCycle(db, simAnchorFn(), 50, 'sim');
  assert.equal(result.leafCount, 1);
});

test('batcherEnabled: default on en real, off en sim; env manda', () => {
  assert.equal(batcherEnabled({}, 'real'), true);
  assert.equal(batcherEnabled({}, 'sim'), false);
  assert.equal(batcherEnabled({ ANCHOR_BATCHER: 'off' }, 'real'), false);
  assert.equal(batcherEnabled({ ANCHOR_BATCHER: 'on' }, 'sim'), true);
});

test('startBatcher: off → null; intervalo configurable; onBatch fires (timer con unref)', async () => {
  const db = new FakeDb();
  assert.equal(startBatcher({ db, mode: 'sim', env: {} }), null);
  await seedLeaves(db, 1);
  const batches: BatchCycleResult[] = [];
  const timer = startBatcher({
    db, mode: 'sim', env: { ANCHOR_BATCHER: 'on', ANCHOR_INTERVAL_MS: '1100' },
    onBatch: (r) => batches.push(r),
  });
  assert.ok(timer);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(batches.length, 1);
  clearInterval(timer);
});

test('startBatcher en modo real sin config: onError y fallas contadas', async () => {
  const db = new FakeDb();
  await seedLeaves(db, 1);
  const counters = { batchesAnchored: 0, anchorFailures: 0 };
  const errors: unknown[] = [];
  const timer = startBatcher({
    db, mode: 'real', env: { ANCHOR_BATCHER: 'on', ANCHOR_INTERVAL_MS: '1100' },
    counters, onError: (e) => errors.push(e),
    providerFactory: () => ({ getNetwork: async () => ({ chainId: 84532n }) }),
    contractFactory: () => ({ anchorReceipts: async () => { throw new Error('insufficient funds'); } }),
  });
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(errors.length, 1);
  assert.equal(counters.anchorFailures, 1);
  assert.equal(db.leaves[0].status, 'failed');
  clearInterval(timer);
});
