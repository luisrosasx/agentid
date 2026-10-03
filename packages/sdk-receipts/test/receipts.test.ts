import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Wallet } from 'ethers';

import {
  merkleRoot,
  receiptDigest,
  signReceipt,
  verifyReceipt,
  type BilateralReceiptMessage,
} from '../src/index.js';

const wallet = Wallet.createRandom();
const base: Omit<BilateralReceiptMessage, 'timestamp'> = {
  agentId: 'agent:alpha',
  counterpartyId: 'agent:beta',
  counterpartyStakeRoot: '0x' + 'b'.repeat(64),
  a2aTaskHash: '0x' + 'c'.repeat(64),
  outcome: 1,
  digest: '0x' + 'd'.repeat(64),
};

function receipt(timestamp = 1_700_000_000n): BilateralReceiptMessage {
  return { ...base, timestamp };
}

test('sign + verify roundtrip passes for the signer', async () => {
  const signed = await signReceipt(receipt(), wallet);
  assert.equal(verifyReceipt(signed), true);
  assert.equal(verifyReceipt(signed, wallet.address), true);
  assert.equal(signed.signer, wallet.address);
});

test('verify fails for a different expected signer', async () => {
  const signed = await signReceipt(receipt(), wallet);
  const other = Wallet.createRandom();
  assert.equal(verifyReceipt(signed, other.address), false);
});

test('verify fails on tampered message', async () => {
  const signed = await signReceipt(receipt(), wallet);
  const tampered = { ...signed, message: { ...signed.message, outcome: 2 } };
  assert.throws(() => verifyReceipt(tampered));
});

test('receipt digest is deterministic per message', () => {
  assert.equal(receiptDigest(receipt()), receiptDigest(receipt()));
  assert.notEqual(receiptDigest(receipt(1n)), receiptDigest(receipt(2n)));
});

test('merkle root is stable and order-sensitive', async () => {
  const a = await signReceipt(receipt(1n), wallet);
  const b = await signReceipt(receipt(2n), wallet);
  const r1 = merkleRoot([a.message, b.message]);
  const r2 = merkleRoot([a.message, b.message]);
  assert.equal(r1, r2);
  assert.notEqual(r1, merkleRoot([b.message, a.message]));
});

test('merkle root handles odd counts and empty list', () => {
  const a = receipt(1n);
  const b = receipt(2n);
  const c = receipt(3n);
  const odd = merkleRoot([a, b, c]);
  const single = merkleRoot([a]);
  const empty = merkleRoot([]);
  assert.notEqual(odd, single);
  assert.notEqual(odd, empty);
  assert.match(odd, /^0x[0-9a-f]{64}$/);
});

test('signReceipt rejects malformed messages', async () => {
  await assert.rejects(
    () => signReceipt({ ...receipt(), agentId: '' }, wallet),
  );
  await assert.rejects(
    () => signReceipt({ ...receipt(), outcome: 999 }, wallet),
  );
});
