export interface DenyReason {
  NO_ATTESTATION: null;
  ATTESTATION_EXPIRED: null;
  DAILY_LIMIT_EXCEEDED: null;
  TARGET_NOT_ALLOWED: null;
  CREDIT_UNAVAILABLE: null;
}

export type DenyReasonCode = keyof DenyReason;

export interface Decision {
  outcome: 'allow' | 'deny';
  agentId: string;
  reason?: DenyReasonCode;
  degraded: boolean;
  /** Present on every degraded response (contract field — EP-26-S3). */
  fallbackReason?: 'resolver_unreachable' | 'credit_unreachable';
}

export interface GatewayMetrics {
  decisions: number;
  allows: number;
  denies: number;
  deniesByReason: Record<DenyReasonCode, number>;
  fallbackTotal: number;
  cacheHits: number;
  cacheMisses: number;
  /** Local latency ring buffer snapshot for the last N enforce() calls. */
  latenciesMs: number[];
}

export interface EnforcerOptions {
  resolverUrl?: string;
  creditUrl?: string;
  /** Local resolver-freshness TTL for cached attestations (default 1h). */
  cacheTtlMs?: number;
  /** Optional credit policy TTL (default 5 min). */
  creditTtlMs?: number;
  /** Allowed targets per agentId. Absent entry for an agent → deny (fail-closed). */
  allowedTargetsByAgent?: Record<string, string[]>;
  fetchFn?: typeof fetch;
}

export function emptyMetrics(): GatewayMetrics {
  return {
    decisions: 0,
    allows: 0,
    denies: 0,
    deniesByReason: {
      NO_ATTESTATION: 0,
      ATTESTATION_EXPIRED: 0,
      DAILY_LIMIT_EXCEEDED: 0,
      TARGET_NOT_ALLOWED: 0,
      CREDIT_UNAVAILABLE: 0,
    },
    fallbackTotal: 0,
    cacheHits: 0,
    cacheMisses: 0,
    latenciesMs: [],
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}
