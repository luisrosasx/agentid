export const CARDCA_DOMAIN = {
  name: 'CardCA',
  version: '1',
} as const;

/** @deprecated Usar CARDCA_DOMAIN. */
export const AGENT_ID_DOMAIN = CARDCA_DOMAIN;

export const MAX_ATTESTATION_VALIDITY_SECONDS = 24 * 60 * 60;

export const RECEIPT_STRUCT_NAME = 'BilateralReceipt' as const;

export const ATTESTATION_STRUCT_NAME = 'Attestation' as const;

export type Eip712TypeDefinition = { name: string; type: string };

export type Eip712Types = Record<string, Eip712TypeDefinition[]>;

export const BilateralReceiptStruct = {
  BilateralReceipt: [
    { name: 'agentId', type: 'string' },
    { name: 'counterpartyId', type: 'string' },
    { name: 'counterpartyStakeRoot', type: 'bytes32' },
    { name: 'a2aTaskHash', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'digest', type: 'bytes32' },
    { name: 'timestamp', type: 'uint256' },
  ],
} as const satisfies Eip712Types;

export const AttestationStruct = {
  Attestation: [
    { name: 'agentId', type: 'string' },
    { name: 'certType', type: 'string' },
    { name: 'capabilitiesHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const satisfies Eip712Types;

export interface BilateralReceiptMessage {
  agentId: string;
  counterpartyId: string;
  counterpartyStakeRoot: string;
  a2aTaskHash: string;
  outcome: number;
  digest: string;
  timestamp: bigint;
}

export interface AttestationMessage {
  agentId: string;
  certType: string;
  capabilitiesHash: string;
  issuedAt: bigint;
  expiresAt: bigint;
}

export function getReceiptTypes(): Eip712Types {
  return {
    ...BilateralReceiptStruct,
  };
}

export function getAttestationTypes(): Eip712Types {
  return {
    ...AttestationStruct,
  };
}

export class AttestationValidityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationValidityError';
  }
}

export function validateAttestationValidity(
  att: Pick<AttestationMessage, 'issuedAt' | 'expiresAt'>,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): void {
  if (typeof att.issuedAt !== 'bigint' || typeof att.expiresAt !== 'bigint') {
    throw new AttestationValidityError('issuedAt and expiresAt must be bigint seconds');
  }
  if (att.issuedAt < 0n || att.expiresAt < 0n) {
    throw new AttestationValidityError('timestamps must be non-negative');
  }
  if (att.expiresAt <= att.issuedAt) {
    throw new AttestationValidityError('expiresAt must be greater than issuedAt');
  }
  const validity = att.expiresAt - att.issuedAt;
  if (validity > BigInt(MAX_ATTESTATION_VALIDITY_SECONDS)) {
    throw new AttestationValidityError(
      `attestation validity exceeds maximum of ${MAX_ATTESTATION_VALIDITY_SECONDS} seconds`,
    );
  }
  if (att.expiresAt <= now) {
    throw new AttestationValidityError('attestation has expired');
  }
}
