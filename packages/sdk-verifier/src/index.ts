import { recoverAddress, verifyTypedData, getAddress, isAddress } from 'ethers';

import {
  AGENT_ID_DOMAIN,
  AttestationValidityError,
  MAX_ATTESTATION_VALIDITY_SECONDS,
  getAttestationTypes,
  type AttestationMessage,
} from '@agentid/schemas';

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
  if (typeof att.agentId !== 'string' || att.agentId.length === 0) {
    throw new AttestationFormatError('agentId must be a non-empty string');
  }
  if (typeof att.certType !== 'string' || att.certType.length === 0) {
    throw new AttestationFormatError('certType must be a non-empty string');
  }
  if (typeof att.capabilitiesHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(att.capabilitiesHash)) {
    throw new AttestationFormatError('capabilitiesHash must be a 32-byte hex string');
  }
  if (typeof att.issuedAt !== 'bigint' || typeof att.expiresAt !== 'bigint') {
    throw new AttestationFormatError('issuedAt and expiresAt must be bigint seconds');
  }
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

  if (att.expiresAt <= att.issuedAt) {
    throw new AttestationValidityError('expiresAt must be greater than issuedAt');
  }
  if (att.expiresAt - att.issuedAt > BigInt(MAX_ATTESTATION_VALIDITY_SECONDS)) {
    throw new AttestationValidityError(
      `attestation validity exceeds maximum of ${MAX_ATTESTATION_VALIDITY_SECONDS} seconds`,
    );
  }
  if (att.expiresAt <= now) {
    throw new AttestationValidityError('attestation has expired');
  }

  const issuer = getAddress(issuerAddress);
  const recovered = recoverAddress(
    { name: AGENT_ID_DOMAIN.name, version: AGENT_ID_DOMAIN.version },
    getAttestationTypes(),
    { ...att },
    signature,
  );

  if (recovered.toLowerCase() !== issuer.toLowerCase()) {
    throw new AttestationFormatError('signature does not match issuerAddress');
  }

  const ok = verifyTypedData(
    { name: AGENT_ID_DOMAIN.name, version: AGENT_ID_DOMAIN.version },
    getAttestationTypes(),
    { ...att },
    signature,
  );

  if (ok.toLowerCase() !== issuer.toLowerCase()) {
    throw new AttestationFormatError('signature verification failed');
  }

  return { signer: recovered, attestation: { ...att } };
}
