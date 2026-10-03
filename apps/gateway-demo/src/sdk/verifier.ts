import { verifyTypedData, getAddress, isAddress } from 'ethers';

import {
  AttestationValidityError,
  MAX_ATTESTATION_VALIDITY_SECONDS,
  type AttestationMessage,
} from './schemas.js';

// Dominio y types idénticos a los del issuer/resolver en producción
// (apps/issuer/src/main.ts) — debe coincidir bit a bit con quien firma.
const DOMAIN = { name: 'AGENT.ID', version: '1', chainId: Number(process.env.CHAIN_ID ?? 31337) };
const ATTESTATION_TYPES = {
  Attestation: [
    { name: 'agentId', type: 'string' },
    { name: 'certType', type: 'string' },
    { name: 'capabilitiesHash', type: 'bytes32' },
    { name: 'challengeId', type: 'string' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
};

export class AttestationFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationFormatError';
  }
}

export interface VerifiedAttestation {
  signer: string;
  attestation: AttestationMessage;
}

function assertAttestationFormat(att: AttestationMessage): void {
  if (att === null || typeof att !== 'object') {
    throw new AttestationFormatError('attestation must be an object');
  }
  const a = att as unknown as Record<string, unknown>;
  if (typeof a['agentId'] !== 'string' || (a['agentId'] as string).length === 0) {
    throw new AttestationFormatError('agentId must be a non-empty string');
  }
  if (typeof a['certType'] !== 'string' || (a['certType'] as string).length === 0) {
    throw new AttestationFormatError('certType must be a non-empty string');
  }
  if (typeof a['capabilitiesHash'] !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(a['capabilitiesHash'] as string)) {
    throw new AttestationFormatError('capabilitiesHash must be a 32-byte hex string');
  }
  if (typeof a['challengeId'] !== 'string') {
    throw new AttestationFormatError('challengeId must be a string');
  }
  if ((typeof a['issuedAt'] !== 'number' && typeof a['issuedAt'] !== 'bigint') ||
      (typeof a['expiresAt'] !== 'number' && typeof a['expiresAt'] !== 'bigint')) {
    throw new AttestationFormatError('issuedAt and expiresAt must be numeric (epoch ms como numbers, como firma el issuer)');
  }
}

/** Convierte issuedAt/expiresAt a ms comparables (bigint seconds o numbers ya en ms). */
function toMs(v: number | bigint): number {
  const n = typeof v === 'bigint' ? Number(v) : v;
  return n > 1_000_000_000_000 ? n : n * 1000;
}

export function verifyAttestation(
  att: AttestationMessage,
  issuerAddress: string,
  signature: string,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): VerifiedAttestation {
  assertAttestationFormat(att);

  if (typeof issuerAddress !== 'string' || !isAddress(issuerAddress)) {
    throw new AttestationFormatError('issuerAddress must be a valid Ethereum address');
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new AttestationFormatError('signature must be a hex string');
  }

  const issuedMs = toMs(att.issuedAt as number | bigint);
  const expiresMs = toMs(att.expiresAt as number | bigint);
  if (expiresMs <= issuedMs) {
    throw new AttestationValidityError('expiresAt must be greater than issuedAt');
  }
  if ((expiresMs - issuedMs) / 1000 > MAX_ATTESTATION_VALIDITY_SECONDS) {
    throw new AttestationValidityError(
      `attestation validity exceeds maximum of ${MAX_ATTESTATION_VALIDITY_SECONDS} seconds`,
    );
  }
  if (expiresMs <= Number(now) * 1000) {
    throw new AttestationValidityError('attestation has expired');
  }

  const issuer = getAddress(issuerAddress);
  const recovered = verifyTypedData(DOMAIN, ATTESTATION_TYPES, att as never, signature);
  if (recovered.toLowerCase() !== issuer.toLowerCase()) {
    throw new AttestationFormatError('signature does not match issuerAddress');
  }

  return { signer: recovered, attestation: { ...att } };
}

export { DOMAIN, ATTESTATION_TYPES };
