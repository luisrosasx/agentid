import { ethers } from 'ethers';

export const KYC_DOMAIN = {
  name: 'AGENT.ID Compliance',
  version: '1',
} as const;

export const KYC_TYPES: Record<string, { name: string; type: string }[]> = {
  KycAttestation: [
    { name: 'operator', type: 'address' },
    { name: 'status', type: 'string' },
    { name: 'issuedAt', type: 'string' },
    { name: 'validUntil', type: 'string' },
  ],
};

export const KYC_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = 90;
export const ERASURE_METHOD = 'burn-nft+salt-rotation+accumulator-exclusion';

export interface KycAttestation {
  operator: string;
  status: 'verified';
  issuedAt: string;
  validUntil: string;
  signature: string;
  signer: string;
}

export async function issueKycAttestation(operatorAddress: string, key: string, now = Date.now()): Promise<KycAttestation> {
  if (!ethers.isAddress(operatorAddress)) throw new Error('operatorAddress must be a valid address');
  const operator = ethers.getAddress(operatorAddress);
  const issuedAt = new Date(now).toISOString();
  const validUntil = new Date(now + KYC_VALIDITY_MS).toISOString();
  const wallet = new ethers.Wallet(key);
  const signature = await wallet.signTypedData(
    KYC_DOMAIN,
    KYC_TYPES,
    { operator, status: 'verified', issuedAt, validUntil },
  );
  return { operator, status: 'verified', issuedAt, validUntil, signature, signer: wallet.address };
}

export interface RetentionReport {
  agentId: string;
  retentionDays: number;
  policy: string;
  eraseAvailable: boolean;
  reportGeneratedAt: string;
}

export function retentionReport(agentId: string, now = Date.now()): RetentionReport {
  return {
    agentId,
    retentionDays: RETENTION_DAYS,
    policy: 'event-data retained for 90 days, then deleted or irreversibly anonymized',
    eraseAvailable: true,
    reportGeneratedAt: new Date(now).toISOString(),
  };
}

export interface ErasureRecord {
  agentId: string;
  method: string;
  erasedAt: string;
  rowsDeleted?: Record<string, number>;
}

export function erasureRecord(agentId: string, rowsDeleted?: Record<string, number>, now = Date.now()): ErasureRecord {
  return { agentId, method: ERASURE_METHOD, erasedAt: new Date(now).toISOString(), rowsDeleted };
}
