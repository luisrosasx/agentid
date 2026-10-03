import { AttestationMessage, validateAttestationValidity } from '@agentid/schemas';

export interface CacheEntry {
  attestation: AttestationMessage;
  signature: string;
  issuer: string;
  fetchedAtMs: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
}

/**
 * Local cache of attestations keyed by agentId.
 *
 * An entry is usable only while BOTH conditions hold:
 *  - the entry itself is younger than `ttlMs` (resolver freshness, default 1h — doc 08 §6), and
 *  - the embedded attestation has not expired cryptographically (checked by callers).
 *
 * Fail-closed: expired or absent entries return null and the caller must deny.
 */
export class AttestationCache {
  private readonly map = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly ttlMs: number = Number(process.env.ATTESTATION_CACHE_TTL_MS ?? 3_600_000)) {}

  static fromRaw(raw: {
    attestation: Record<string, unknown>;
    signature: string;
    issuer: string;
  }): CacheEntry {
    const a = raw.attestation;
    return {
      attestation: {
        agentId: String(a['agentId']),
        certType: String(a['certType']),
        capabilitiesHash: String(a['capabilitiesHash']),
        issuedAt: toSeconds(a['issuedAt']),
        expiresAt: toSeconds(a['expiresAt']),
      },
      signature: String(raw.signature),
      issuer: String(raw.issuer),
      fetchedAtMs: Date.now(),
    };
  }

  set(agentId: string, entry: CacheEntry): void {
    this.map.set(agentId, entry);
  }

  /** Returns the entry only if the local TTL is still fresh; otherwise counts a miss. */
  getFresh(agentId: string, nowMs: number = Date.now()): CacheEntry | null {
    const entry = this.map.get(agentId);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (nowMs - entry.fetchedAtMs > this.ttlMs) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return entry;
  }

  /** Hard check: is the attestation inside its cryptographic validity window? */
  isValid(entry: CacheEntry, now: bigint = BigInt(Math.floor(Date.now() / 1000))): boolean {
    try {
      validateAttestationValidity(entry.attestation, now);
      return true;
    } catch {
      return false;
    }
  }

  stats(): CacheStats {
    return { size: this.map.size, hits: this.hits, misses: this.misses };
  }
}

/** Accepts epoch seconds (bigint or number ≤ 1e12) or epoch millis (number > 1e12). */
function toSeconds(v: unknown): bigint {
  const n = typeof v === 'bigint' ? v : BigInt(Math.floor(Number(v)));
  if (n > 1_000_000_000_000n) return n / 1000n; // milliseconds
  return n;
}
