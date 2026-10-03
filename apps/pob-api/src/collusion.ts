import type { StoredReceipt } from './receipts.js';

export interface CollusionSignals {
  reciprocityCycles: number;
  top1Share: number;
  hhi: number;
}

export interface CollusionReport {
  agentId: string;
  collusionRisk: 'none' | 'low' | 'high';
  signals: CollusionSignals;
}

export const RECIPROCITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const HIGH_TOP1_SHARE = 0.5;
export const HIGH_MIN_CYCLES = 3;
export const LOW_HHI = 0.25;

export interface CounterpartyIndex {
  /** All receipts stored by any agent, used to look up mirror (reciprocal) ratings. */
  all: StoredReceipt[];
}

/**
 * Builds the counterparty graph of one agent from the receipt store and computes the
 * EP-21 anti-collusion signals: mutual-rating cycles within the 7-day window, top-1
 * counterparty concentration and counterparty diversity via the HHI.
 */
export function analyzeCollusion(
  agentId: string,
  agentReceipts: StoredReceipt[],
  allReceipts: StoredReceipt[],
  now = Date.now(),
): CollusionReport {
  const windowStart = now - RECIPROCITY_WINDOW_MS;
  const recent = agentReceipts.filter((r) => Date.parse(r.issuedAt) >= windowStart);

  // Edge set of the agent's graph within the window, with per-counterparty counts.
  const counts = new Map<string, number>();
  for (const r of recent) counts.set(r.counterparty.toLowerCase(), (counts.get(r.counterparty.toLowerCase()) ?? 0) + 1);
  const total = recent.length;

  let reciprocityCycles = 0;
  if (total > 0) {
    // Mirror ratings: receipts stored by counterparties that rate this agent back in the window.
    const reciprocal = new Map<string, boolean>();
    for (const r of allReceipts) {
      const cp = r.counterparty.toLowerCase();
      if (r.agentId !== agentId && counts.has(r.agentId.toLowerCase()) && cp === agentId.toLowerCase() && Date.parse(r.issuedAt) >= windowStart) {
        reciprocal.set(r.agentId.toLowerCase(), true);
      }
    }
    for (const cp of counts.keys()) if (reciprocal.get(cp)) reciprocityCycles += 1;
  }

  let top1Share = 0;
  let hhi = 0;
  if (total > 0) {
    for (const n of counts.values()) {
      const share = n / total;
      top1Share = Math.max(top1Share, share);
      hhi += share * share;
    }
  }

  const high = top1Share > HIGH_TOP1_SHARE || reciprocityCycles >= HIGH_MIN_CYCLES;
  const low = !high && (top1Share > 0.2 || reciprocityCycles >= 1 || hhi > LOW_HHI);
  return {
    agentId,
    collusionRisk: high ? 'high' : low ? 'low' : 'none',
    signals: { reciprocityCycles, top1Share, hhi },
  };
}
