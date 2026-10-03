import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { buildApp } from '../src/server.js';
import { POB_DOMAIN, RECEIPT_TYPES } from '../src/receipts.js';
import { MemoryRecordsStore } from '../src/records.js';
import type { ReceiptStore } from '../src/store.js';
import type { StoredReceipt } from '../src/receipts.js';

test('e2e: recibo → contradicción → slash → score 0', async () => {
  const app = await buildApp({ receipts: new TestReceiptStore(), records: new MemoryRecordsStore() });

  const agentWallet = Wallet.createRandom();
  const mirrorWallet = Wallet.createRandom();
  const agentId = agentWallet.address;
  const nonce = `task-e2e-1`;
  const issuedAt = new Date().toISOString();

  const agentReceipt = { agentId, counterparty: mirrorWallet.address, outcome: 'positive', nonce, issuedAt };
  const mirrorReceipt = { agentId: mirrorWallet.address, counterparty: agentId, outcome: 'negative', nonce, issuedAt };
  const sigA = await agentWallet.signTypedData(POB_DOMAIN, RECEIPT_TYPES, agentReceipt as never);
  const sigB = await mirrorWallet.signTypedData(POB_DOMAIN, RECEIPT_TYPES, mirrorReceipt as never);

  const r1 = await app.inject({ method: 'POST', url: '/receipt', payload: { receipt: agentReceipt, signature: sigA } });
  assert.equal(r1.statusCode, 201);
  const r2 = await app.inject({ method: 'POST', url: '/receipt', payload: { receipt: mirrorReceipt, signature: sigB } });
  assert.equal(r2.statusCode, 201);

  // score normal antes de la contradicción
  const scoreBefore = await app.inject({ method: 'GET', url: `/score/${agentId}` });
  assert.equal(scoreBefore.statusCode, 200);
  assert.ok(scoreBefore.json()['score'] > 0);

  // atestación cruzada detecta outcome-divergence y registra evidencia
  const ca = await app.inject({ method: 'POST', url: '/cross-attest', payload: { agentId } });
  assert.equal(ca.statusCode, 200);
  const report = ca.json();
  assert.equal(report['verdict'], 'contested');
  const divergence = report['contradictions'].find((c: { type: string }) => c.type === 'outcome-divergence');
  assert.ok(divergence, 'debe detectar outcome-divergence');

  // slash con evidencia no registrada → 403
  const bad = await app.inject({
    method: 'POST',
    url: '/slash',
    payload: { agentId, evidenceHash: '0x' + '0'.repeat(64), contradictionType: 'outcome-divergence' },
  });
  assert.equal(bad.statusCode, 403);

  // slash con evidencia registrada → 201
  const slash = await app.inject({
    method: 'POST',
    url: '/slash',
    payload: { agentId, evidenceHash: divergence['evidenceHash'], contradictionType: divergence['type'] },
  });
  assert.equal(slash.statusCode, 201);

  // historial
  const history = await app.inject({ method: 'GET', url: `/slash/${agentId}` });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json()['slashes'].length, 1);
  assert.equal(history.json()['slashes'][0]['contradictionType'], 'outcome-divergence');

  // score del agente slasheado → 0
  const scoreAfter = await app.inject({ method: 'GET', url: `/score/${agentId}` });
  assert.equal(scoreAfter.statusCode, 200);
  assert.equal(scoreAfter.json()['score'], 0);
  assert.equal(scoreAfter.json()['slashed'], true);
});

test('e2e: /settle registra el settlement y el batchRoot del día es estable', async () => {
  const app = await buildApp({ receipts: new TestReceiptStore(), records: new MemoryRecordsStore() });
  const r1 = await app.inject({
    method: 'POST',
    url: '/settle',
    payload: { gatewayId: 'gw-1', volumeCreditoWei: '1000000000000000000', tier: 1 },
  });
  assert.equal(r1.statusCode, 200);
  const body = r1.json();
  assert.equal(body['gatewayBps'], 60);
  assert.equal(body['agentidBps'], 90);
  assert.equal(body['gatewayAmountWei'], '6000000000000000');
  assert.equal(body['agentidAmountWei'], '9000000000000000');
  assert.match(body['batchRoot'], /^0x[0-9a-f]{64}$/);

  const r2 = await app.inject({
    method: 'POST',
    url: '/settle',
    payload: { gatewayId: 'gw-2', volumeCreditoWei: '2000000000000000000', tier: 3 },
  });
  assert.equal(r2.statusCode, 200);
  // el root del segundo settlement incluye ambos (cambia respecto al primero)
  assert.notEqual(r2.json()['batchRoot'], body['batchRoot']);
});

test('e2e: /colusion responde con señales para un agente sin recibos', async () => {
  const app = await buildApp({ receipts: new TestReceiptStore(), records: new MemoryRecordsStore() });
  const res = await app.inject({ method: 'GET', url: '/colusion/nobody' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()['collusionRisk'], 'none');
});

test('e2e: /cross-attest con agentId inexistente → clean', async () => {
  const app = await buildApp({ receipts: new TestReceiptStore(), records: new MemoryRecordsStore() });
  const res = await app.inject({ method: 'POST', url: '/cross-attest', payload: { agentId: 'ghost' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()['verdict'], 'clean');
  assert.deepEqual(res.json()['contradictions'], []);
});

/** Store in-memory de recibos mínimo para tests e2e (mismo contrato que openReceiptStore). */
class TestReceiptStore implements ReceiptStore {
  mode = 'memory' as const;
  private byAgent = new Map<string, StoredReceipt[]>();
  private seen = new Set<string>();

  async insert(receipt: StoredReceipt): Promise<void> {
    const key = `${receipt.agentId}|${receipt.counterparty.toLowerCase()}|${receipt.nonce}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const list = this.byAgent.get(receipt.agentId) ?? [];
    list.push(receipt);
    this.byAgent.set(receipt.agentId, list);
  }

  async listByAgent(agentId: string): Promise<StoredReceipt[]> {
    return [...(this.byAgent.get(agentId) ?? [])];
  }

  async listAll(): Promise<StoredReceipt[]> {
    const all: StoredReceipt[] = [];
    for (const list of this.byAgent.values()) all.push(...list);
    return all;
  }
}
