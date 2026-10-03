import type { AttestationMessage } from '@agentid/schemas';
import type { CacheEntry } from './cache.js';

export interface ResolverEntry {
  attestation: Record<string, unknown>;
  signature: string;
  issuer: string;
}

/**
 * HTTP client for the resolver (apps/resolver): `GET /resolve/:agentId`.
 *
 * The URL is configurable via `resolverUrl` (default `RESOLVER_URL` env, then
 * `http://localhost:3000`). Every failure (network, timeout, 404, malformed
 * payload) resolves to `null` — never throws — so the caller can fail closed.
 */
export class ResolverClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(
    opts: { resolverUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.url = (opts.resolverUrl ?? process.env.RESOLVER_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.RESOLVER_TIMEOUT_MS ?? 500);
    this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  }

  private fetchFn: typeof fetch;

  async getAttestation(agentId: string): Promise<ResolverEntry | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.url}/resolve/${encodeURIComponent(agentId)}`, {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      if (body['valid'] !== true) return null;
      const attestation = body['attestation'];
      const signature = body['signature'];
      const issuer = body['issuer'];
      if (
        attestation === null || typeof attestation !== 'object' ||
        typeof signature !== 'string' || typeof issuer !== 'string'
      ) {
        return null;
      }
      return { attestation: attestation as Record<string, unknown>, signature, issuer };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface CreditPolicy {
  dailyLimitWei: string;
}

/**
 * HTTP client for the credit service (apps/credit): `GET /account/:agentId`
 * returns the underwriter policy, notably `dailyLimitWei`. Same fail-null
 * semantics as ResolverClient: any failure returns null (deny by default).
 */
export class CreditClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(opts: { creditUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.url = (opts.creditUrl ?? process.env.CREDIT_URL ?? 'http://localhost:3010').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.CREDIT_TIMEOUT_MS ?? 500);
    this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  }

  async getPolicy(agentId: string): Promise<CreditPolicy | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.url}/account/${encodeURIComponent(agentId)}`, {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      const limit = body['dailyLimitWei'];
      if (typeof limit !== 'string' || !/^\d+$/.test(limit)) return null;
      return { dailyLimitWei: limit };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export type { AttestationMessage, CacheEntry };
