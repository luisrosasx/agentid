import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test de paridad TS↔TS: la réplica de apps/interchange debe producir EXACTAMENTE
// los mismos splits y batchRoot que el módulo original de pob-api.
import {
  agentidBpsForVolume,
  batchRootForDay,
  settlementLeaf,
  splitInterchange,
  type SettlementRecord,
} from '../../pob-api/src/settlement.js';
import {
  agentidBpsForVolume as agentidBpsReplica,
  batchRootForDay as batchRootReplica,
  settlementLeaf as leafReplica,
  splitInterchange as splitReplica,
} from '../src/settlement.js';

const T = 10n ** 18n;

function sampleRecords(): Omit<SettlementRecord, 'batchRoot'>[] {
  const volumes = [10_000n * T, 100_000n * T, 1_000_000n * T, 50_000_000n * T, 200_000_000n * T];
  return volumes.map((v, i) => {
    const s = splitInterchange(v, (i % 5) + 1);
    return {
      gatewayId: `gw-${i + 1}`,
      tier: (i % 5) + 1,
      volumeWei: v.toString(),
      gatewayBps: s.gatewayBps,
      agentidBps: s.agentidBps,
      gatewayAmountWei: s.gatewayAmountWei,
      agentidAmountWei: s.agentidAmountWei,
      day: '2026-01-15',
      settledAt: '2026-01-15T23:59:59.000Z',
    };
  });
}

test('paridad de splits: réplica === pob-api en 200 volúmenes × 5 tiers', () => {
  let seed = 987654321n;
  const rand = () => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return seed >> 16n;
  };
  for (let i = 0; i < 200; i++) {
    const volume = rand() % (600_000_000n * T);
    for (let tier = 1; tier <= 5; tier++) {
      assert.deepEqual(splitReplica(volume, tier), splitInterchange(volume, tier));
    }
  }
  const thresholds = [100_000n * T, 1_000_000n * T, 10_000_000n * T, 100_000_000n * T, 1_000_000_000n * T];
  for (const t of thresholds) {
    for (const v of [t - 1n, t, t + 1n]) {
      assert.equal(agentidBpsReplica(v), agentidBpsForVolume(v));
    }
  }
});

test('paridad de leaves y batchRoot: réplica === pob-api', () => {
  const records = sampleRecords();
  for (const r of records) {
    assert.equal(leafReplica(r), settlementLeaf(r));
  }
  assert.equal(batchRootReplica(records), batchRootForDay(records));
});
