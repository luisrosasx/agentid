import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { buildBatch } from '../src/batcher.js';
import { splitInterchange, type SettlementRecord } from '../src/settlement.js';

const T = 10n ** 18n;

function memoryFetcher(records: SettlementRecord[]) {
  return async (day: string) => records.filter((r) => r.day === day);
}

function rec(gatewayId: string, tier: number, volumeWei: bigint, day = '2026-01-15'): SettlementRecord {
  const s = splitInterchange(volumeWei, tier);
  return {
    gatewayId,
    tier,
    volumeWei: volumeWei.toString(),
    gatewayBps: s.gatewayBps,
    agentidBps: s.agentidBps,
    gatewayAmountWei: s.gatewayAmountWei,
    agentidAmountWei: s.agentidAmountWei,
    batchRoot: '0x' + '0'.repeat(64),
    day,
    settledAt: new Date().toISOString(),
  };
}

test('healthz responde ok', async () => {
  const app = await buildApp({ fetchSettlements: memoryFetcher([]) });
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()['service'], 'interchange');
  await app.close();
});

test('POST /batch/day construye payload del día desde pob-api (fetcher inyectado)', async () => {
  const records = [rec('gw-1', 1, 50_000n * T), rec('gw-2', 2, 300_000n * T)];
  const app = await buildApp({ fetchSettlements: memoryFetcher(records) });
  const res = await app.inject({ method: 'POST', url: '/batch/day', payload: { day: '2026-01-15' } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body['day'], '2026-01-15');
  assert.equal(body['dayUint'], '20260115');
  assert.equal(body['gatewayCount'], 2);
  // el payload es directamente reconcile-able
  const rec2 = await app.inject({ method: 'POST', url: '/batch/reconcile', payload: { payload: body } });
  assert.equal(rec2.statusCode, 200);
  assert.equal(rec2.json()['ok'], true);
  await app.close();
});

test('POST /batch/day falla con 400 si no hay settlements', async () => {
  const app = await buildApp({ fetchSettlements: memoryFetcher([]) });
  const res = await app.inject({ method: 'POST', url: '/batch/day', payload: { day: '2026-01-20' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /batch/day valida formato de día', async () => {
  const app = await buildApp({ fetchSettlements: memoryFetcher([]) });
  const res = await app.inject({ method: 'POST', url: '/batch/day', payload: { day: 'nope' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /batch/reconcile rechaza payload inválido', async () => {
  const app = await buildApp({ fetchSettlements: memoryFetcher([]) });
  const res = await app.inject({ method: 'POST', url: '/batch/reconcile', payload: { payload: { day: 'x' } } });
  assert.equal(res.statusCode, 400);
  const res2 = await app.inject({ method: 'POST', url: '/batch/reconcile', payload: {} });
  assert.equal(res2.statusCode, 400);
  await app.close();
});

test('POST /batch/reconcile detecta manipulación roundtrip', async () => {
  const records = [rec('gw-1', 1, 50_000n * T)];
  const app = await buildApp({ fetchSettlements: memoryFetcher(records) });
  const built = buildBatch(records);
  built.settlements[0]!.record.agentidAmountWei = '1';
  const res = await app.inject({ method: 'POST', url: '/batch/reconcile', payload: { payload: built } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()['ok'], false);
  await app.close();
});
