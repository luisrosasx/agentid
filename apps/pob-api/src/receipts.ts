import { ethers } from 'ethers';

export interface PobReceipt {
  agentId: string;
  counterparty: string;
  outcome: string;
  nonce: string;
  issuedAt: string;
}

export const POB_DOMAIN = {
  name: 'CardCA Proof-of-Behavior',
  version: '1',
} as const;

export const RECEIPT_TYPES: Record<string, { name: string; type: string }[]> = {
  Receipt: [
    { name: 'agentId', type: 'string' },
    { name: 'counterparty', type: 'address' },
    { name: 'outcome', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'issuedAt', type: 'string' },
  ],
};

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface VerifiedReceipt {
  receipt: PobReceipt;
  signer: string;
}

export function verifyReceipt(receipt: unknown, signature: string, now = Date.now()): VerifiedReceipt {
  if (typeof receipt !== 'object' || receipt === null) throw new Error('receipt must be an object');
  const r = receipt as Record<string, unknown>;
  for (const k of ['agentId', 'counterparty', 'outcome', 'nonce', 'issuedAt']) {
    if (typeof r[k] !== 'string' || (r[k] as string).length === 0) throw new Error(`receipt.${k} must be a non-empty string`);
  }
  const counterparty = r['counterparty'] as string;
  if (!ethers.isAddress(counterparty)) throw new Error('receipt.counterparty must be a valid address');
  const issuedAt = r['issuedAt'] as string;
  const ts = Date.parse(issuedAt);
  if (Number.isNaN(ts)) throw new Error('receipt.issuedAt must be an ISO timestamp');
  if (ts > now + 60_000) throw new Error('receipt.issuedAt is in the future');
  if (now - ts > MAX_AGE_MS) throw new Error('receipt.issuedAt is older than 7 days');
  const value = {
    agentId: r['agentId'] as string,
    counterparty,
    outcome: r['outcome'] as string,
    nonce: r['nonce'] as string,
    issuedAt,
  };
  const signer = ethers.verifyTypedData(POB_DOMAIN, RECEIPT_TYPES, value, signature);
  return { receipt: value, signer: ethers.getAddress(signer) };
}

const POSITIVE_OUTCOMES = new Set(['positive', 'success', 'completed', 'satisfied']);

export function isPositiveOutcome(outcome: string): boolean {
  return POSITIVE_OUTCOMES.has(outcome.toLowerCase());
}

export interface StoredReceipt extends PobReceipt {
  signer: string;
  receivedAt: string;
}

export interface AgentScore {
  score: number;
  receipts: number;
  distinctCounterparties: number;
  computedAt: string;
}

/**
 * Deterministic composite score in [0, 100]:
 *  - 40% weight: distinct counterparties, capped at 20
 *  - 40% weight: share of positive outcomes
 *  - 20% weight: age of history, capped at 365 days since the oldest receipt
 */
export function computeScore(receipts: StoredReceipt[], now = Date.now()): AgentScore {
  const unique = new Map<string, StoredReceipt>();
  for (const r of receipts) unique.set(r.nonce, r);
  const list = [...unique.values()];
  const counterparties = new Set(list.map((r) => r.counterparty.toLowerCase()));
  const positives = list.filter((r) => isPositiveOutcome(r.outcome)).length;
  const positiveRate = list.length === 0 ? 0 : positives / list.length;
  const oldest = list.reduce<number | null>(
    (acc, r) => (acc === null ? Date.parse(r.issuedAt) : Math.min(acc, Date.parse(r.issuedAt))),
    null,
  );
  const ageDays = oldest === null ? 0 : Math.max(0, (now - oldest) / 86_400_000);
  const raw =
    (Math.min(counterparties.size, 20) / 20) * 40 +
    positiveRate * 40 +
    (Math.min(ageDays, 365) / 365) * 20;
  return {
    score: Math.min(100, Math.round(raw)),
    receipts: list.length,
    distinctCounterparties: counterparties.size,
    computedAt: new Date(now).toISOString(),
  };
}

export async function signCredential(
  payload: { agentId: string; score: number; validUntil: string },
  key: string,
): Promise<string> {
  const wallet = new ethers.Wallet(key);
  const canonical = JSON.stringify([payload.agentId, payload.score, payload.validUntil]);
  return wallet.signMessage(canonical);
}

export function ephemeralKey(): string {
  return ethers.Wallet.createRandom().privateKey;
}
