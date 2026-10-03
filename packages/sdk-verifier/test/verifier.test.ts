import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Wallet } from 'ethers';

import { AttestationValidityError } from '@agentid/schemas';
import { AttestationFormatError, verifyAttestation } from '../src/index.js';

const issuer = Wallet.createRandom();
const now = 1_700_000_000n;

function attestation(overrides: Partial<Parameters<typeof verifyAttestation>[0]> = {}) {
  return {
    agentId: 'agent:example',
    certType: 'AGENT.CERT',
    capabilitiesHash: '0x' + 'a'.repeat(64),
    issuedAt: now,
    expiresAt: now + 3600n,
    ...overrides,
  };
}

async function sign(att: ReturnType<typeof attestation>, wallet = issuer) {
  return wallet.signTypedData(
    { name: 'AGENT.ID', version: '1' },
    {
      Attestation: [
        { name: 'agentId', type: 'string' },
        { name: 'certType', type: 'string' },
        { name: 'capabilitiesHash', type: 'bytes32' },
        { name: 'issuedAt', type: 'uint256' },
        { name: 'expiresAt', type: 'uint256' },
      ],
    },
    att,
  );
}

test('valid signature from issuer passes', async () => {
  const att = attestation();
  const sig = await sign(att);
  const result = verifyAttestation(att, issuer.address, sig, now + 60n);
  assert.equal(result.signer.toLowerCase(), issuer.address.toLowerCase());
  assert.equal(result.attestation.agentId, att.agentId);
});

test('expired attestation fails', async () => {
  const att = attestation();
  const sig = await sign(att);
  assert.throws(
    () => verifyAttestation(att, issuer.address, sig, now + 3601n),
    AttestationValidityError,
  );
});

test('validity > 24h fails', async () => {
  const att = attestation({ expiresAt: now + 24n * 3600n + 1n });
  const sig = await sign(att);
  assert.throws(
    () => verifyAttestation(att, issuer.address, sig, now + 60n),
    AttestationValidityError,
  );
});

test('signature from a different wallet fails', async () => {
  const att = attestation();
  const sig = await sign(att, Wallet.createRandom());
  assert.throws(
    () => verifyAttestation(att, issuer.address, sig, now + 60n),
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
        now + 60n,
      ),
    AttestationFormatError,
  );
  assert.throws(
    () => verifyAttestation({ ...att, capabilitiesHash: '0x123' }, issuer.address, sig, now + 60n),
    AttestationFormatError,
  );
  assert.throws(
    () => verifyAttestation(att, 'not-an-address', sig, now + 60n),
    AttestationFormatError,
  );
  assert.throws(() => verifyAttestation(att, issuer.address, 'deadbeef', now + 60n), AttestationFormatError);
});
