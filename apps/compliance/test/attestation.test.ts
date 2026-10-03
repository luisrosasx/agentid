import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import {
  erasureRecord,
  ERASURE_METHOD,
  issueKycAttestation,
  KYC_DOMAIN,
  KYC_TYPES,
  KYC_VALIDITY_MS,
  retentionReport,
  RETENTION_DAYS,
} from '../src/attestation.js';
import { verifyTypedData } from 'ethers';

test('issueKycAttestation produces a verifiable EIP-712 attestation valid for 30 days', async () => {
  const key = Wallet.createRandom().privateKey;
  const now = Date.now();
  const a = await issueKycAttestation(Wallet.createRandom().address, key, now);
  const signer = verifyTypedData(KYC_DOMAIN, KYC_TYPES, { operator: a.operator, status: a.status, issuedAt: a.issuedAt, validUntil: a.validUntil }, a.signature);
  assert.equal(signer, a.signer);
  assert.equal(Date.parse(a.validUntil) - Date.parse(a.issuedAt), KYC_VALIDITY_MS);
});

test('issueKycAttestation rejects invalid addresses', async () => {
  await assert.rejects(() => issueKycAttestation('not-an-address', Wallet.createRandom().privateKey));
});

test('issueKycAttestation is checksummed', async () => {
  const addr = Wallet.createRandom().address.toLowerCase();
  const a = await issueKycAttestation(addr, Wallet.createRandom().privateKey);
  assert.notEqual(a.operator, addr); // checksummed, not the lowercase input
  assert.equal(a.operator.toLowerCase(), addr);
});

test('retention report uses the 90-day policy', () => {
  const r = retentionReport('agent-1');
  assert.equal(r.retentionDays, RETENTION_DAYS);
  assert.equal(r.retentionDays, 90);
  assert.equal(r.agentId, 'agent-1');
});

test('erasure record uses the documented method', () => {
  const r = erasureRecord('agent-1');
  assert.equal(r.method, ERASURE_METHOD);
  assert.equal(r.method, 'burn-nft+salt-rotation+accumulator-exclusion');
});
