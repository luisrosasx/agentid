import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBatch, type BatchPayload } from '../src/batcher.js';
import { reconcile } from '../src/reconcile.js';
import { splitInterchange, type SettlementRecord } from '../src/settlement.js';

const T = 10n ** 18n;

function rec(gatewayId: string, tier: number, volumeWei: bigint, day = '2026-01-15', batchRoot = '0x' + '0'.repeat(64)): SettlementRecord {
  const s = splitInterchange(volumeWei, tier);
  return {
    gatewayId,
    tier,
    volumeWei: volumeWei.toString(),
    gatewayBps: s.gatewayBps,
    agentidBps: s.agentidBps,
    gatewayAmountWei: s.gatewayAmountWei,
    agentidAmountWei: s.agentidAmountWei,
    batchRoot,
    day,
    settledAt: new Date().toISOString(),
  };
}

test('buildBatch produce payload settleDay-ready con proofs verificables', () => {
  const records = [rec('gw-1', 1, 50_000n * T), rec('gw-2', 3, 2_000_000n * T), rec('gw-3', 5, 500_000_000n * T)];
  const payload = buildBatch(records);
  assert.equal(payload.day, '2026-01-15');
  assert.equal(payload.dayUint, '20260115');
  assert.equal(payload.gatewayCount, 3);
  assert.equal(payload.totalVolumeWei, (50_000n * T + 2_000_000n * T + 500_000_000n * T).toString());
  assert.match(payload.batchRoot, /^0x[0-9a-f]{64}$/);
  assert.equal(payload.settlements.length, 3);
  assert.equal(payload.settlements[0]!.proof.length, 2); // 3 leaves → 2 niveles de proof
});

test('reconcile OK con payload íntegro', () => {
  const payload = buildBatch([rec('gw-1', 2, 500_000n * T), rec('gw-2', 4, 75_000n * T)]);
  const result = reconcile(payload);
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatched, []);
  assert.equal(result.checked, 2);
});

test('reconcile detecta payload manipulado', () => {
  const payload: BatchPayload = buildBatch([rec('gw-1', 2, 500_000n * T), rec('gw-2', 4, 75_000n * T)]);
  // monto manipulado
  const tampered: BatchPayload = structuredClone(payload);
  tampered.settlements[0]!.record.gatewayAmountWei = '1';
  const r1 = reconcile(tampered);
  assert.equal(r1.ok, false);
  assert.ok(r1.mismatched.some((m) => m.gatewayId === 'gw-1'));
  // totalVolume manipulado
  const tamperedTotal: BatchPayload = structuredClone(payload);
  tamperedTotal.totalVolumeWei = '1';
  assert.equal(reconcile(tamperedTotal).ok, false);
  // root manipulado
  const tamperedRoot: BatchPayload = structuredClone(payload);
  tamperedRoot.batchRoot = '0x' + 'ab'.repeat(32);
  assert.equal(reconcile(tamperedRoot).ok, false);
  // proof manipulado
  const tamperedProof: BatchPayload = structuredClone(payload);
  tamperedProof.settlements[0]!.proof[0] = '0x' + 'cd'.repeat(32);
  const r2 = reconcile(tamperedProof);
  assert.equal(r2.ok, false);
  assert.ok(r2.mismatched.some((m) => m.reason.includes('merkle')));
});

test('buildBatch rechaza día vacío y mezcla de días', () => {
  assert.throws(() => buildBatch([]));
  assert.throws(() => buildBatch([rec('gw-1', 1, T), rec('gw-2', 1, T, '2026-01-16')]));
});
