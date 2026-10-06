export const DPIA_DATA_CATEGORIES = [
  'agent identifiers (agentId)',
  'challenge proofs and nonces',
  'proof-of-behavior receipts (counterparty, outcome)',
  'attestations and EIP-712 signatures',
  'credit decisions',
  'kyc attestations (operator address)',
];

export const DPIA_LAWFUL_BASIS =
  'contract performance and fraud prevention (GDPR art. 6.1.b / 6.1.f)';

export const DPIA_PROCESSOR = 'CardCA (Nexgen Systems)';

export interface DpiaReport {
  agentId: string;
  dataCategories: string[];
  retentionDays: number;
  erasable: boolean;
  lawfulBasis: string;
  processor: string;
}

export function dpiaReport(agentId: string, retentionDays = 90): DpiaReport {
  return {
    agentId,
    dataCategories: DPIA_DATA_CATEGORIES,
    retentionDays,
    erasable: true,
    lawfulBasis: DPIA_LAWFUL_BASIS,
    processor: DPIA_PROCESSOR,
  };
}
