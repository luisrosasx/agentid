import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import {
  computeScore,
  isPositiveOutcome,
  RECEIPT_TYPES,
  POB_DOMAIN,
  signCredential,
  verifyReceipt,
  type StoredReceipt,
} from '../src/receipts.js';

const counterparty = Wallet.createRandom().address;

async function makeReceipt(overrides: Partial<Record<string, string>> = {}): Promise<{ receipt: Record<string, string>; signature: string }> {
  const receipt = {
    agentId: 'agent-1',
    counterparty,
    outcome: 'positive',
    nonce: 'n1',
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
  const signature = await new Wallet(Wallet.createRandom().privateKey).signTypedData(
    POB_DOMAIN,
    RECEIPT_TYPES,
    receipt as never,
  );
  return { receipt, signature };
}

test('verifyReceipt accepts a validly signed receipt and recovers the signer', async () => {
  const { receipt, signature } = await makeReceipt();
  const verified = verifyReceipt(receipt, signature);
  assert.ok(/^0x[0-9a-fA-F]{40}$/.test(verified.signer));
  assert.equal(verified.receipt.agentId, 'agent-1');
});

test('verifyReceipt recovers the exact signing address', async () => {
  const wallet = Wallet.createRandom();
  const receipt = {
    agentId: 'agent-1',
    counterparty,
    outcome: 'positive',
    nonce: 'n2',
    issuedAt: new Date().toISOString(),
  };
  const signature = await wallet.signTypedData(POB_DOMAIN, RECEIPT_TYPES, receipt as never);
  const verified = verifyReceipt(receipt, signature);
  assert.equal(verified.signer, wallet.address);
});

test('verifyReceipt detects a tampered receipt via signer mismatch', async () => {
  const { receipt, signature } = await makeReceipt();
  const signer = verifyReceipt(receipt, signature).signer;
  const tampered = verifyReceipt({ ...receipt, outcome: 'negative' }, signature).signer;
  assert.notEqual(signer, tampered);
});

test('verifyReceipt rejects invalid counterparty addresses', async () => {
  const { receipt, signature } = await makeReceipt();
  assert.throws(() => verifyReceipt({ ...receipt, counterparty: 'not-an-address' }, signature));
});

test('verifyReceipt rejects stale and future receipts', async () => {
  const stale = await makeReceipt({ issuedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });
  assert.throws(() => verifyReceipt(stale.receipt, stale.signature));
  const future = await makeReceipt({ issuedAt: new Date(Date.now() + 3600_000).toISOString() });
  assert.throws(() => verifyReceipt(future.receipt, future.signature));
});

test('isPositiveOutcome is case-insensitive and strict', () => {
  assert.equal(isPositiveOutcome('Positive'), true);
  assert.equal(isPositiveOutcome('negative'), false);
});

test('computeScore is deterministic and bounded', () => {
  const now = Date.now();
  const mk = (nonce: string, cp: string, outcome: string, ageDays: number): StoredReceipt => ({
    agentId: 'agent-1',
    counterparty: cp,
    outcome,
    nonce,
    issuedAt: new Date(now - ageDays * 86_400_000).toISOString(),
    signer: Wallet.createRandom().address,
    receivedAt: new Date(now).toISOString(),
  });
  const receipts = [
    mk('a', Wallet.createRandom().address, 'positive', 10),
    mk('b', Wallet.createRandom().address, 'negative', 5),
    mk('a2', Wallet.createRandom().address, 'positive', 1),
  ];
  const s1 = computeScore(receipts, now);
  const s2 = computeScore(receipts, now);
  assert.deepEqual(s1, s2);
  assert.ok(s1.score >= 0 && s1.score <= 100);
  assert.equal(s1.receipts, 3);
  assert.equal(s1.distinctCounterparties, 3);
  assert.equal(computeScore([], now).score, 0);
  const maxCase = Array.from({ length: 20 }, (_, i) =>
    mk(`max-${i}`, Wallet.createRandom().address, 'positive', 400),
  );
  assert.equal(computeScore(maxCase, now).score, 100);
});

test('signCredential is stable for a given key', async () => {
  const key = Wallet.createRandom().privateKey;
  const payload = { agentId: 'agent-1', score: 42, validUntil: '2026-01-01T00:00:00.000Z' };
  assert.equal(await signCredential(payload, key), await signCredential(payload, key));
});
