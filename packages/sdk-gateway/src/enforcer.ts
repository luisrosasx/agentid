import { verifyAttestation, AttestationFormatError } from '@agentid/sdk-verifier';
import { AttestationValidityError, type AttestationMessage } from '@agentid/schemas';

import { AttestationCache, type CacheEntry } from './cache.js';
import { ResolverClient, CreditClient, type ResolverEntry, type CreditPolicy } from './clients.js';
import { emptyMetrics, percentile, type Decision, type DenyReasonCode, type GatewayMetrics, type EnforcerOptions } from './metrics.js';

const LATENCY_WINDOW = 10_000;

/**
 * Gateway enforcement core (EP-26).
 *
 * Decides `allow | deny` for (agentId, target, amountWei) combining:
 *  1. a valid AGENT.CERT attestation (cache hit <1ms; miss → fetch resolver),
 *  2. the daily limit from the credit service (cached locally), and
 *  3. an allowed-targets policy.
 *
 * Fail-closed: no valid cached/fetched attestation, no reachable credit policy,
 * or no target policy → deny. Never fails open.
 */
export class GatewayEnforcer {
  private readonly cache: AttestationCache;
  private readonly resolver: ResolverClient;
  private readonly credit: CreditClient;
  private readonly creditTtlMs: number;
  private readonly allowedTargetsByAgent: Record<string, string[]>;
  private readonly metrics: GatewayMetrics = emptyMetrics();
  private readonly creditPolicies = new Map<string, { policy: CreditPolicy; fetchedAtMs: number }>();
  private readonly spentToday = new Map<string, { day: string; spentWei: bigint }>();

  constructor(opts: EnforcerOptions = {}) {
    this.cache = new AttestationCache(opts.cacheTtlMs ?? Number(process.env.ATTESTATION_CACHE_TTL_MS ?? 3_600_000));
    this.resolver = new ResolverClient({ resolverUrl: opts.resolverUrl, fetchFn: opts.fetchFn });
    this.credit = new CreditClient({ creditUrl: opts.creditUrl, fetchFn: opts.fetchFn });
    this.creditTtlMs = opts.creditTtlMs ?? 300_000;
    this.allowedTargetsByAgent = opts.allowedTargetsByAgent ?? {};
  }

  /**
   * Sync fast path used by the async `enforce()` and by the benchmark: decides
   * strictly from local cache/policy state with zero I/O.
   */
  enforceCached(
    agentId: string,
    target: string,
    amountWei: bigint | string,
    nowMs: number = Date.now(),
  ): Decision {
    const startNs = process.hrtime.bigint();
    try {
      const amount = BigInt(amountWei);
      const entry = this.cache.getFresh(agentId, nowMs);
      if (entry === null) {
        return this.deny(agentId, 'NO_ATTESTATION', true, 'resolver_unreachable');
      }
      if (!this.cache.isValid(entry, BigInt(Math.floor(nowMs / 1000)))) {
        return this.deny(agentId, 'ATTESTATION_EXPIRED', false);
      }
      const allowed = this.allowedTargetsByAgent[agentId];
      if (!Array.isArray(allowed) || !allowed.some((t) => t.toLowerCase() === target.toLowerCase())) {
        return this.deny(agentId, 'TARGET_NOT_ALLOWED', false);
      }
      const policy = this.creditPolicies.get(agentId);
      if (!policy || nowMs - policy.fetchedAtMs > this.creditTtlMs) {
        return this.deny(agentId, 'CREDIT_UNAVAILABLE', true, 'credit_unreachable');
      }
      const today = new Date(nowMs).toISOString().slice(0, 10);
      const spent = this.spentToday.get(agentId);
      const spentWei = spent && spent.day === today ? spent.spentWei : 0n;
      if (spentWei + amount > BigInt(policy.policy.dailyLimitWei)) {
        return this.deny(agentId, 'DAILY_LIMIT_EXCEEDED', false);
      }
      this.metrics.decisions += 1;
      this.metrics.allows += 1;
      this.recordSpend(agentId, amount, today);
      return { outcome: 'allow', agentId, degraded: false };
    } finally {
      const elapsed = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      this.metrics.latenciesMs.push(elapsed);
      if (this.metrics.latenciesMs.length > LATENCY_WINDOW) this.metrics.latenciesMs.shift();
    }
  }

  /**
   * Full enforce path: local cache first (hot path, no network), and on a miss
   * fetches resolver + credit. Any fetch failure denies (fail-closed) and marks
   * the decision degraded with a `fallbackReason`.
   */
  async enforce(agentId: string, target: string, amountWei: bigint | string): Promise<Decision> {
    const nowMs = Date.now();
    const fresh = this.cache.getFresh(agentId, nowMs);
    if (fresh !== null) {
      this.metrics.cacheHits += 1;
      return this.enforceCached(agentId, target, amountWei, nowMs);
    }
    this.metrics.cacheMisses += 1;

    const rawEntry = await this.resolver.getAttestation(agentId);
    if (rawEntry === null) {
      return this.deny(agentId, 'NO_ATTESTATION', true, 'resolver_unreachable');
    }
    let entry: CacheEntry;
    try {
      entry = AttestationCache.fromRaw(rawEntry);
    } catch {
      return this.deny(agentId, 'NO_ATTESTATION', true, 'resolver_unreachable');
    }
    if (!this.cache.isValid(entry, BigInt(Math.floor(nowMs / 1000)))) {
      return this.deny(agentId, 'ATTESTATION_EXPIRED', false);
    }
    try {
      const verified = verifyAttestation(
        entry.attestation,
        entry.issuer,
        entry.signature,
        BigInt(Math.floor(nowMs / 1000)),
      );
      entry.attestation = verified.attestation as AttestationMessage;
    } catch (err) {
      void err; // bad signature/format → fail-closed, degraded
      return this.deny(agentId, 'NO_ATTESTATION', true, 'resolver_unreachable');
    }
    this.cache.set(agentId, entry);

    let policy = this.creditPolicies.get(agentId);
    if (!policy || nowMs - policy.fetchedAtMs > this.creditTtlMs) {
      const fetched = await this.credit.getPolicy(agentId);
      if (fetched === null) {
        return this.deny(agentId, 'CREDIT_UNAVAILABLE', true, 'credit_unreachable');
      }
      policy = { policy: fetched, fetchedAtMs: nowMs };
      this.creditPolicies.set(agentId, policy);
    }

    return this.enforceCached(agentId, target, amountWei, nowMs);
  }

  private deny(
    agentId: string,
    reason: DenyReasonCode,
    degraded: boolean,
    fallbackReason?: 'resolver_unreachable' | 'credit_unreachable',
  ): Decision {
    this.metrics.decisions += 1;
    this.metrics.denies += 1;
    this.metrics.deniesByReason[reason] += 1;
    if (degraded) {
      this.metrics.fallbackTotal += 1;
      return { outcome: 'deny', agentId, reason, degraded: true, fallbackReason };
    }
    return { outcome: 'deny', agentId, reason, degraded: false };
  }

  private recordSpend(agentId: string, amount: bigint, today: string): void {
    const spent = this.spentToday.get(agentId);
    if (spent && spent.day === today) {
      spent.spentWei += amount;
    } else {
      this.spentToday.set(agentId, { day: today, spentWei: amount });
    }
  }

  getMetrics(): GatewayMetrics {
    return {
      ...this.metrics,
      deniesByReason: { ...this.metrics.deniesByReason },
      latenciesMs: [...this.metrics.latenciesMs],
    };
  }

  /** Internal benchmark: N sequential cache-hot enforceCached() calls. */
  benchmark(n: number = 5_000): { p50: number; p99: number; mean: number; n: number } {
    const latencies: number[] = [];
    for (let i = 0; i < n; i++) {
      const start = process.hrtime.bigint();
      this.enforceCached('agent:bench', '0x' + '1'.repeat(40), 1n);
      latencies.push(Number(process.hrtime.bigint() - start) / 1_000_000);
    }
    return {
      p50: percentile(latencies, 50),
      p99: percentile(latencies, 99),
      mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      n,
    };
  }
}

export { AttestationCache, ResolverClient, CreditClient, percentile };
export type { CacheEntry, ResolverEntry, CreditPolicy, Decision, DenyReasonCode, GatewayMetrics, EnforcerOptions };
