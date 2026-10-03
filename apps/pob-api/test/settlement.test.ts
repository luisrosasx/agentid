import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentidBpsForVolume, batchRootForDay, GATEWAY_BPS_BY_TIER, settlementLeaf, splitInterchange } from '../src/settlement.js';

const T = 10n ** 18n;

test('gatewayBps escalonado 25-60 decreciente con tier (5 tiers)', () => {
  assert.deepEqual([...GATEWAY_BPS_BY_TIER], [60, 50, 40, 32, 25]);
  for (let tier = 1; tier <= 5; tier++) {
    const s = splitInterchange(1000n * T, tier);
    assert.equal(s.gatewayBps, GATEWAY_BPS_BY_TIER[tier - 1]);
    assert.ok(s.gatewayBps >= 25 && s.gatewayBps <= 60);
  }
});

test('agentidBps entre 50 y 90, decreciente con volumen', () => {
  assert.equal(agentidBpsForVolume(50_000n * T), 90);
  assert.equal(agentidBpsForVolume(500_000n * T), 80);
  assert.equal(agentidBpsForVolume(5_000_000n * T), 70);
  assert.equal(agentidBpsForVolume(50_000_000n * T), 60);
  assert.equal(agentidBpsForVolume(500_000_000n * T), 50);
});

test('reparto exacto para 5 tiers: montos = volumen * bps / 10000 y no exceden el volumen', () => {
  for (let tier = 1; tier <= 5; tier++) {
    const volume = 123_456_789n * T;
    const s = splitInterchange(volume, tier);
    assert.equal(s.gatewayAmountWei, ((volume * BigInt(s.gatewayBps)) / 10_000n).toString());
    assert.equal(s.agentidAmountWei, ((volume * BigInt(s.agentidBps)) / 10_000n).toString());
    const gateway = BigInt(s.gatewayAmountWei);
    const agentid = BigInt(s.agentidAmountWei);
    assert.ok(gateway + agentid <= volume, 'la retención combinada nunca excede el volumen');
    assert.ok(s.agentidBps >= 50 && s.agentidBps <= 90);
  }
});

test('rechaza tier inválido y volumen negativo', () => {
  assert.throws(() => splitInterchange(T, 0));
  assert.throws(() => splitInterchange(T, 6));
  assert.throws(() => splitInterchange(-1n, 1));
});

test('batchRoot es un merkle determinístico de los settlements del día', () => {
  const base = {
    gatewayId: 'gw-1',
    tier: 1,
    volumeWei: '1000000000000000000',
    gatewayBps: 60,
    agentidBps: 90,
    gatewayAmountWei: '6000000000000000',
    agentidAmountWei: '9000000000000000',
    day: '2026-01-15',
    settledAt: new Date().toISOString(),
  };
  const root1 = batchRootForDay([base, { ...base, gatewayId: 'gw-2' }]);
  const root2 = batchRootForDay([base, { ...base, gatewayId: 'gw-2' }]);
  assert.equal(root1, root2);
  assert.match(root1, /^0x[0-9a-f]{64}$/);
  assert.equal(settlementLeaf(base), settlementLeaf(base));
  assert.notEqual(settlementLeaf(base), settlementLeaf({ ...base, gatewayAmountWei: '1' }));
});
