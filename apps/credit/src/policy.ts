export const BASE_LIMIT_WEI = 1_000_000_000_000_000_000n; // 1 ETH
export const DEFAULT_SCORE = 50;
export const POLICY_VERSION = '1.0.0';

export interface CreditPolicy {
  agentId: string;
  dailyLimitWei: string;
  allowedTargets: string[];
  underwriting: 'human-review-required';
  policyVersion: string;
  score: number;
  scoreSource: 'pob' | 'default';
}

export async function fetchScore(pobUrl: string | undefined, agentId: string): Promise<{ score: number; source: 'pob' | 'default' }> {
  if (!pobUrl) return { score: DEFAULT_SCORE, source: 'default' };
  try {
    const res = await fetch(`${pobUrl.replace(/\/$/, '')}/score/${encodeURIComponent(agentId)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { score?: unknown };
    const score = Number(body.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('score out of range');
    return { score: Math.round(score), source: 'pob' };
  } catch {
    return { score: DEFAULT_SCORE, source: 'default' };
  }
}

/**
 * dailyLimitWei scales the 1 ETH base limit linearly with the PoB score:
 * base * score / 100, always at least 1 wei.
 */
export function computePolicy(agentId: string, score: number, scoreSource: 'pob' | 'default'): CreditPolicy {
  const dailyLimitWei = (BASE_LIMIT_WEI * BigInt(Math.round(score))) / 100n;
  return {
    agentId,
    dailyLimitWei: (dailyLimitWei > 0n ? dailyLimitWei : 1n).toString(),
    allowedTargets: [],
    underwriting: 'human-review-required',
    policyVersion: POLICY_VERSION,
    score,
    scoreSource,
  };
}
