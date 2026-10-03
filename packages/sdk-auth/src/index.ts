import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ethers } from 'ethers';

export type NonceStore = {
  seen: (nonce: string) => Promise<boolean>;
};

export class InMemoryNonceStore implements NonceStore {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, number>();

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  async seen(nonce: string): Promise<boolean> {
    const now = Date.now();
    for (const [key, expires] of this.entries) {
      if (expires <= now) this.entries.delete(key);
    }
    const prev = this.entries.get(nonce);
    if (prev !== undefined && prev > now) return true;
    this.entries.set(nonce, now + this.ttlMs);
    return false;
  }
}

function authOff(): boolean {
  return (process.env.AUTH_MODE ?? '').toLowerCase() === 'off' || process.env.AUTH_MODE === undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface RequireServiceAuthOptions {
  keys: string[];
}

function deny(reply: FastifyReply, payload: Record<string, string>): void {
  reply.code(401).send(payload);
}

export function requireServiceAuth(opts: RequireServiceAuthOptions) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (authOff()) return undefined;
    const key = req.headers['x-service-key'];
    if (typeof key !== 'string' || !opts.keys.some((k) => safeEqual(key, k))) {
      deny(reply, { error: 'unauthorized' });
      return;
    }
    return undefined;
  };
}

export interface RequireHmacOptions {
  secrets: Record<string, string>;
  windowMs?: number;
  nonceStore?: NonceStore;
}

export function computeHmacSignature(method: string, path: string, bodySha256Hex: string, secret: string): string {
  const message = `${method}\n${path}\n${bodySha256Hex}`;
  return 'sha256=' + createHmac('sha256', secret).update(message).digest('hex');
}

export function sha256Hex(body: string | Buffer | undefined): string {
  return createHash('sha256').update(body ?? '').digest('hex');
}

export function requireHmac(opts: RequireHmacOptions) {
  const windowMs = opts.windowMs ?? 5 * 60 * 1000;
  const store = opts.nonceStore ?? new InMemoryNonceStore();
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (authOff()) return undefined;
    const serviceId = req.headers['x-service-id'];
    const timestamp = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];
    const secret = typeof serviceId === 'string' ? opts.secrets[serviceId] : undefined;
    if (!secret) {
      deny(reply, { error: 'bad_signature' });
      return;
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > windowMs) {
      deny(reply, { error: 'stale_timestamp' });
      return;
    }
    const rawBody = (req as unknown as { rawBody?: string | Buffer }).rawBody;
    const bodySha = sha256Hex(rawBody);
    const expected = computeHmacSignature(req.method, new URL(req.url, 'http://localhost').pathname, bodySha, secret);
    if (typeof signature !== 'string' || !safeEqual(signature, expected)) {
      deny(reply, { error: 'bad_signature' });
      return;
    }
    const nonce = createHash('sha256').update(`${signature}${timestamp}`).digest('hex');
    if (await store.seen(nonce)) {
      deny(reply, { error: 'replay' });
      return;
    }
    return undefined;
  };
}

export interface RequireOperatorOptions {
  operatorAddresses: string[];
  nonceStore?: NonceStore;
}

export const OPERATOR_DOMAIN = {
  name: 'AGENT.ID',
  version: '1',
} as const;

export const OPERATOR_TYPES = {
  OperatorAttestation: [
    { name: 'operatorAddress', type: 'address' },
    { name: 'purpose', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'timestamp', type: 'uint64' },
  ],
};

export function requireOperator(opts: RequireOperatorOptions) {
  const store = opts.nonceStore ?? new InMemoryNonceStore();
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (authOff()) return undefined;
    const header = req.headers['x-operator-signature'];
    const nonce = req.headers['x-operator-nonce'];
    const timestamp = req.headers['x-operator-timestamp'];
    if (typeof header !== 'string' || typeof nonce !== 'string' || typeof timestamp !== 'string') {
      deny(reply, { error: 'bad_operator_signature' });
      return;
    }
    let signer: string;
    try {
      const tsBig = BigInt(timestamp);
      const address = ethers.getAddress(req.headers['x-operator-address'] as string);
      const message = { operatorAddress: address, purpose: 'kyc-attestation', nonce, timestamp: tsBig };
      const recovered = ethers.getAddress(ethers.verifyTypedData(OPERATOR_DOMAIN, OPERATOR_TYPES, message, header));
      if (recovered !== address) throw new Error('mismatch');
      const tsMs = Number(tsBig);
      if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) throw new Error('stale');
      signer = recovered;
    } catch {
      deny(reply, { error: 'bad_operator_signature' });
      return;
    }
    if (!opts.operatorAddresses.some((a) => a.toLowerCase() === signer.toLowerCase())) {
      deny(reply, { error: 'bad_operator_signature' });
      return;
    }
    if (await store.seen(`op:${nonce}:${signer.toLowerCase()}`)) {
      deny(reply, { error: 'replay' });
      return;
    }
    return undefined;
  };
}
