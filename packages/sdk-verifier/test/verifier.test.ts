import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Wallet } from 'ethers';

import { AttestationValidityError } from '@cardca/schemas';
import { ATTESTATION_TYPES, AttestationFormatError, DOMAIN, verifyAttestation } from '../src/index.js';

const issuer = Wallet.createRandom();
const nowSec = 1_700_000_000n;
const nowMs = 1_700_000_000_000;

function attestation(overrides: Partial<Parameters<typeof verifyAttestation>[0]> = {}) {
  return {
    agentId: 'agent:example',
    certType: 'AGENT.CERT',
    capabilitiesHash: '0x' + 'a'.repeat(64),
    challengeId: 'challenge-1',
    issuedAt: nowMs,
    expiresAt: nowMs + 3600_000,
    ...overrides,
  };
}

// Firma exactamente como el issuer real (apps/issuer/src/main.ts):
// dominio con chainId 31337, challengeId y epoch ms como uint64.
async function sign(att: ReturnType<typeof attestation>, wallet = issuer) {
  return wallet.signTypedData(DOMAIN, ATTESTATION_TYPES, att as never);
}

test('valid signature from issuer passes', async () => {
  const att = attestation();
  const sig = await sign(att);
  const result = verifyAttestation(att, issuer.address, sig, nowSec + 60n);
  assert.equal(result.signer.toLowerCase(), issuer.address.toLowerCase());
  assert.equal(result.attestation.agentId, att.agentId);
  assert.equal(result.attestation.challengeId, 'challenge-1');
});

test('valid signature also accepted with bigint seconds form', async () => {
  const att = attestation({ issuedAt: nowSec, expiresAt: nowSec + 3600n });
  const sig = await sign(att);
  const result = verifyAttestation(att, issuer.address, sig, nowSec + 60n);
  assert.equal(result.signer.toLowerCase(), issuer.address.toLowerCase());
});

test('expired attestation fails', async () => {
  const att = attestation();
  const sig = await sign(att);
  assert.throws(
    () => verifyAttestation(att, issuer.address, sig, nowSec + 3601n),
    AttestationValidityError,
  );
});

test('validity > 24h fails', async () => {
  const att = attestation({ expiresAt: nowMs + 24 * 3600 * 1000 + 1000 });
  const sig = await sign(att);
  assert.throws(
    () => verifyAttestation(att, issuer.address, sig, nowSec + 60n),
    AttestationValidityError,
  );
});

test('signature from a different wallet fails', async () => {
  const att = attestation();
  const sig = await sign(att, Wallet.createRandom());
  assert.throws(
    () => verifyAttestation(att, issuer.address, sig, nowSec + 60n),
    AttestationFormatError,
  );
});

test('signature over a different chainId fails (domain mismatch)', async () => {
  const att = attestation();
  const sig = await issuer.signTypedData(
    { name: 'CardCA', version: '1', chainId: 1 },
    ATTESTATION_TYPES,
    att as never,
  );
  assert.throws(
    () => verifyAttestation(att, issuer.address, sig, nowSec + 60n),
    AttestationFormatError,
  );
});

test('missing challengeId fails format check', () => {
  const att: Record<string, unknown> = { ...attestation() };
  delete att['challengeId'];
  assert.throws(
    () => verifyAttestation(att as never, issuer.address, '0x00', nowSec + 60n),
    AttestationFormatError,
  );
});

test('fail-closed on invalid format', async () => {
  const att = attestation();
  const sig = await sign(att);
  assert.throws(
    () =>
      verifyAttestation(
        { ...att, agentId: '' },
        issuer.address,
        sig,
        nowSec + 60n,
      ),
    AttestationFormatError,
  );
  assert.throws(
    () => verifyAttestation({ ...att, capabilitiesHash: '0x123' }, issuer.address, sig, nowSec + 60n),
    AttestationFormatError,
  );
  assert.throws(
    () => verifyAttestation(att, 'not-an-address', sig, nowSec + 60n),
    AttestationFormatError,
  );
  assert.throws(() => verifyAttestation(att, issuer.address, 'deadbeef', nowSec + 60n), AttestationFormatError);
});
