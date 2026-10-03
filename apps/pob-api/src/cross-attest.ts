import { ethers } from 'ethers';
import type { StoredReceipt } from './receipts.js';
import { isPositiveOutcome } from './receipts.js';

export type ContradictionType =
  | 'outcome-divergence'
  | 'timestamp-skew'
  | 'digest-divergence'
  | 'replay'
  | 'unilateral-anchor';

export interface Contradiction {
  type: ContradictionType;
  nonce: string;
  agentId: string;
  counterparty: string;
  evidenceHash: string;
}

export interface CrossAttestReport {
  agentId: string;
  contradictions: Contradiction[];
  verdict: 'clean' | 'contested';
}

export const TIMESTAMP_SKEW_MS = 60_000;

export function receiptDigest(r: StoredReceipt): string {
  return ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify([r.agentId, r.counterparty, r.outcome, r.nonce, r.issuedAt])),
  );
}

function makeContradiction(type: ContradictionType, nonce: string, agentId: string, counterparty: string): Contradiction {
  const seed = { type, nonce, agentId, counterparty };
  return { ...seed, evidenceHash: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(seed))) };
}

/**
 * Compares the receipts stored by an agent against the mirror receipts stored by its
 * counterparties (matched by shared nonce) and detects the five contradiction classes
 * of EP-18: outcome divergence, timestamp skew >60s, duplicate receipt with a different
 * digest, nonce replay and unilateral anchoring (receipt without a registered mirror).
 */
export function crossAttest(agentReceipts: StoredReceipt[], counterpartyReceipts: StoredReceipt[]): {
  contradictions: Contradiction[];
  verdict: 'clean' | 'contested';
} {
  const contradictions: Contradiction[] = [];
  const push = (c: Contradiction) => {
    if (!contradictions.some((x) => x.evidenceHash === c.evidenceHash)) contradictions.push(c);
  };

  const mirrorsByNonce = new Map<string, StoredReceipt[]>();
  for (const r of counterpartyReceipts) {
    const list = mirrorsByNonce.get(r.nonce) ?? [];
    list.push(r);
    mirrorsByNonce.set(r.nonce, list);
  }

  const byNonce = new Map<string, StoredReceipt[]>();
  for (const r of agentReceipts) {
    const list = byNonce.get(r.nonce) ?? [];
    list.push(r);
    byNonce.set(r.nonce, list);
  }

  for (const [nonce, dupes] of byNonce) {
    const first = dupes[0];
    // nonce reused across counterparties → replay
    const counterparties = new Set(dupes.map((r) => r.counterparty.toLowerCase()));
    if (dupes.length > 1 && counterparties.size > 1) {
      push(makeContradiction('replay', nonce, first.agentId, first.counterparty));
    }
    // duplicate receipt with a different digest
    const digests = new Set(dupes.map(receiptDigest));
    if (digests.size > 1) {
      push(makeContradiction('digest-divergence', nonce, first.agentId, first.counterparty));
    }

    const mirrors = mirrorsByNonce.get(nonce) ?? [];
    if (mirrors.length === 0) {
      push(makeContradiction('unilateral-anchor', nonce, first.agentId, first.counterparty));
      continue;
    }
    const mirror = mirrors[0];
    if (isPositiveOutcome(first.outcome) !== isPositiveOutcome(mirror.outcome)) {
      push(makeContradiction('outcome-divergence', nonce, first.agentId, first.counterparty));
    }
    const skew = Math.abs(Date.parse(first.issuedAt) - Date.parse(mirror.issuedAt));
    if (skew > TIMESTAMP_SKEW_MS) {
      push(makeContradiction('timestamp-skew', nonce, first.agentId, first.counterparty));
    }
  }

  return { contradictions, verdict: contradictions.length === 0 ? 'clean' : 'contested' };
}
