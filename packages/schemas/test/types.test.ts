import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  AGENT_ID_DOMAIN,
  MAX_ATTESTATION_VALIDITY_SECONDS,
  AttestationValidityError,
  getAttestationTypes,
  getReceiptTypes,
  validateAttestationValidity,
} from '../src/index.js';

const now = 1_700_000_000n;

const validAtt = {
  agentId: 'agent:example',
  certType: 'AGENT.CERT',
  capabilitiesHash: '0x' + 'a'.repeat(64),
  issuedAt: now,
  expiresAt: now + 3600n,
};

test('domain has AGENT.ID name and version 1', () => {
  assert.equal(AGENT_ID_DOMAIN.name, 'AGENT.ID');
  assert.equal(AGENT_ID_DOMAIN.version, '1');
});

test('receipt types include all BilateralReceipt fields', () => {
  const types = getReceiptTypes();
  const fields = types.BilateralReceipt.map((f) => f.name);
  assert.deepEqual(fields, [
    'agentId',
    'counterpartyId',
    'counterpartyStakeRoot',
    'a2aTaskHash',
    'outcome',
    'digest',
    'timestamp',
  ]);
});

test('attestation types include all Attestation fields', () => {
  const types = getAttestationTypes();
  const fields = types.Attestation.map((f) => f.name);
  assert.deepEqual(fields, ['agentId', 'certType', 'capabilitiesHash', 'issuedAt', 'expiresAt']);
});

test('validateAttestationValidity accepts a valid 1h attestation', () => {
  assert.doesNotThrow(() => validateAttestationValidity(validAtt, now + 60n));
});

test('validateAttestationValidity accepts a 24h attestation exactly', () => {
  const att = { ...validAtt, expiresAt: now + BigInt(MAX_ATTESTATION_VALIDITY_SECONDS) };
  assert.doesNotThrow(() => validateAttestationValidity(att, now + 60n));
});

test('validateAttestationValidity rejects validity > 24h', () => {
  const att = { ...validAtt, expiresAt: now + BigInt(MAX_ATTESTATION_VALIDITY_SECONDS) + 1n };
  assert.throws(() => validateAttestationValidity(att, now + 60n), AttestationValidityError);
});

test('validateAttestationValidity rejects expired attestation', () => {
  assert.throws(() => validateAttestationValidity(validAtt, now + 3601n), AttestationValidityError);
});

test('validateAttestationValidity rejects expiresAt <= issuedAt', () => {
  const att = { ...validAtt, expiresAt: now };
  assert.throws(() => validateAttestationValidity(att, now + 60n), AttestationValidityError);
});

test('validateAttestationValidity rejects non-bigint timestamps', () => {
  assert.throws(
    () => validateAttestationValidity({ issuedAt: 123 as unknown as bigint, expiresAt: 456n }),
    AttestationValidityError,
  );
});
