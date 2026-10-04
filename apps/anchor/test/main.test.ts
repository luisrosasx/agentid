import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toUtf8Bytes } from 'ethers';
import { buildApp, resolveAnchorMode, merkleRoot, MAX_BATCH, type BuildAppOptions } from '../src/main.ts';
import { FakeDb } from './fakedb.ts';

let db: FakeDb;
let simOpts: BuildAppOptions;

beforeEach(() => {
  db = new FakeDb();
  simOpts = { env: { ANCHOR_MODE: 'sim', LOG_LEVEL: 'error' }, db };
});

test('boot falla sin ANCHOR_MODE (fail-closed)', async () => {
  assert.throws(() => resolveAnchorMode({}), /ANCHOR_MODE no está definido/);
  await assert.rejects(buildApp({ env: {}, db: null }), /ANCHOR_MODE no está definido/);
});

test('ANCHOR_MODE inválido también falla', async () => {
  assert.throws(() => resolveAnchorMode({ ANCHOR_MODE: 'yolo' }), /ANCHOR_MODE inválido/);
});

test('sim explícito funciona', async () => {
  const built = await buildApp(simOpts);
  const res = await built.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().mode, 'sim');
});

test('healthz', async () => {
  const built = await buildApp(simOpts);
  const res = await built.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, service: 'anchor', mode: 'sim' });
});

test('merkle root is deterministic and order-sensitive', () => {
  const a = ['0xaa', '0xbb'].map((x) => keccak256(x)) as unknown as string[];
  const b = ['0xaa', '0xbb'].map((x) => keccak256(x)) as unknown as string[];
  assert.equal(merkleRoot(a), merkleRoot(b));
  const swapped = ['0xbb', '0xaa'].map((x) => keccak256(x)) as unknown as string[];
  assert.notEqual(merkleRoot(a), merkleRoot(swapped));
});

test('odd leaf count duplicates last leaf', async () => {
  const { concat } = await import('ethers');
  const one = [keccak256(toUtf8Bytes('a'))];
  const leaf = keccak256(toUtf8Bytes('a'));
  const real = keccak256(concat([leaf, leaf]));
  assert.equal(merkleRoot(one), real);
});

test('anchors a batch (sim)', async () => {
  const built = await buildApp(simOpts);
  const res = await built.app.inject({
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
  assert.equal(body.blockNumber, null);
});

test('rejects empty and oversized batches', async () => {
  const built = await buildApp(simOpts);
  const empty = await built.app.inject({ method: 'POST', url: '/anchor', payload: { attestations: [] } });
  assert.equal(empty.statusCode, 400);
  const big = await built.app.inject({ method: 'POST', url: '/anchor', payload: { attestations: Array(MAX_BATCH + 1).fill({}) } });
  assert.equal(big.statusCode, 413);
});

// ---------- 7.4: real con tx fallida → 502 y sin txHash falso ----------

function realEnv(deploymentsPath: string): NodeJS.ProcessEnv {
  return {
    ANCHOR_MODE: 'real',
    DEPLOYER_PRIVATE_KEY: '0x' + 'aa'.repeat(32),
    ANCHOR_DEPLOYMENTS_PATH: deploymentsPath,
    LOG_LEVEL: 'error',
  };
}

function failingChain(): { onchainProviderFactory: unknown; onchainContractFactory: unknown } {
  return {
    onchainProviderFactory: () => ({ getNetwork: async () => ({ chainId: 84532n }) }),
    onchainContractFactory: () => ({
      anchorReceipts: async () => ({
        hash: '0x' + 'ff'.repeat(32),
        wait: async () => ({ status: 0, blockNumber: undefined }),
      }),
    }),
  };
}

test('real con tx fallida → 502 {mode:"real", error} y sin txHash falso', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-real-'));
  const deploymentsPath = join(dir, 'deployments.json');
  writeFileSync(deploymentsPath, JSON.stringify({
    network: 'base-sepolia', chainId: 84532,
    contracts: { AgentIdRegistry: '0x1111111111111111111111111111111111111111', CertIssuer: '0x2222222222222222222222222222222222222222', BehaviorProof: '0x3333333333333333333333333333333333333333' },
  }));
  try {
    const fake = failingChain();
    const built = await buildApp({ env: realEnv(deploymentsPath), db, ...fake });
    const res = await built.app.inject({
      method: 'POST', url: '/anchor', payload: { attestations: [{ x: 1 }] },
    });
    assert.equal(res.statusCode, 502);
    const body = res.json();
    assert.equal(body.mode, 'real');
    assert.ok(body.error);
    assert.equal(body.txHash, undefined);
    // y nada se persiste como ancla
    assert.equal(db.anchors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real sin deployments → 503 (no simula)', async () => {
  const built = await buildApp({ env: { ANCHOR_MODE: 'real', DEPLOYER_PRIVATE_KEY: '0x' + 'aa'.repeat(32), LOG_LEVEL: 'error' }, db });
  const res = await built.app.inject({ method: 'POST', url: '/anchor', payload: { attestations: [{ x: 1 }] } });
  assert.equal(res.statusCode, 503);
});

// ---------- 7.6: /anchors/latest y proof ----------

test('anchors/latest y proof de hoja del lote', async () => {
  const built = await buildApp(simOpts);
  // cola con hojas
  const leaves = Array.from({ length: 5 }, (_, i) => keccak256(toUtf8Bytes(`leaf:${i}`)));
  let res = await built.app.inject({ method: 'POST', url: '/leaves', payload: { agentId: 'agent:demo', leafHashes: leaves } });
  assert.equal(res.statusCode, 201);
  // batcher run (sim)
  res = await built.app.inject({ method: 'POST', url: '/batcher/run', payload: { batchSize: 10 } });
  assert.equal(res.statusCode, 200);
  const batch = res.json();
  assert.equal(batch.leafCount, 5);
  assert.match(batch.root, /^0x[0-9a-f]{64}$/);
  assert.match(batch.txHash, /^0x[0-9a-f]{64}$/);

  res = await built.app.inject({ method: 'GET', url: '/anchors/latest' });
  assert.equal(res.statusCode, 200);
  const latest = res.json();
  assert.equal(latest.batchId, batch.batchId);
  assert.equal(latest.root, batch.root);
  assert.equal(latest.txHash, batch.txHash);
  assert.equal(latest.mode, 'sim');
  assert.equal(latest.leaves, 5);

  res = await built.app.inject({ method: 'GET', url: `/anchors/${batch.batchId}/proof/${leaves[2]}` });
  assert.equal(res.statusCode, 200);
  const proof = res.json();
  assert.equal(proof.valid, true);
  assert.ok(proof.proof.length > 0);

  // hoja ajena → 404
  res = await built.app.inject({ method: 'GET', url: `/anchors/${batch.batchId}/proof/${keccak256(toUtf8Bytes('ajena'))}` });
  assert.equal(res.statusCode, 404);
});

test('anchors/latest sin db → 503; con db vacía → 404', async () => {
  const noDb = await buildApp({ env: { ANCHOR_MODE: 'sim', LOG_LEVEL: 'error' }, db: null });
  const res1 = await noDb.app.inject({ method: 'GET', url: '/anchors/latest' });
  assert.equal(res1.statusCode, 503);
  const withDb = await buildApp(simOpts);
  const res2 = await withDb.app.inject({ method: 'GET', url: '/anchors/latest' });
  assert.equal(res2.statusCode, 404);
});
