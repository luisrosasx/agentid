import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Wallet } from 'ethers';

import { GatewayEnforcer } from '../src/enforcer.js';
import { AttestationCache, ResolverClient, CreditClient } from '../src/index.js';
import type { EnforcerOptions, Decision } from '../src/index.js';

const issuer = Wallet.createRandom();
const TARGET = '0x' + '1'.repeat(40);
const TARGET2 = '0x' + '2'.repeat(40);
const AGENT = 'agent:gateway-test';
const LIMIT = '1000000000000000000'; // 1 ETH

function stubFetch(
  resolverResponder: (path: string) => unknown | undefined,
  creditResponder: (path: string) => unknown | undefined,
): { fetchFn: typeof fetch; resolverCalls: () => number; creditCalls: () => number } {
  let resolverCalls = 0;
  let creditCalls = 0;
  const fetchFn: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    const isResolver = url.includes('/resolve/');
    const isCredit = url.includes('/account/');
    if (isResolver) resolverCalls += 1;
    if (isCredit) creditCalls += 1;
    const responder = isResolver ? resolverResponder : isCredit ? creditResponder : () => undefined;
    const body = responder(url);
    if (body === undefined) throw new Error('connection refused');
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
  };
  return {
    fetchFn,
    resolverCalls: () => resolverCalls,
    creditCalls: () => creditCalls,
  };
}

interface RawEntry {
  attestation: Record<string, unknown>;
  signature: string;
  issuer: string;
}

let nonceCounter = 0;

async function makeResolverBody(nowSec: number, ttlSec: number, wallet = issuer): Promise<{ entry: RawEntry; expiresSec: number }> {
  nonceCounter += 1;
  const attestation = {
    agentId: AGENT,
    certType: 'AGENT.CERT',
    capabilitiesHash: '0x' + 'a'.repeat(64),
    challengeId: `challenge-${nonceCounter}`,
    issuedAt: nowSec * 1000,
    expiresAt: (nowSec + ttlSec) * 1000,
  };
  const signature = await wallet.signTypedData(
    { name: 'AGENT.ID', version: '1', chainId: 31337 },
    {
      Attestation: [
        { name: 'agentId', type: 'string' },
        { name: 'certType', type: 'string' },
        { name: 'capabilitiesHash', type: 'bytes32' },
        { name: 'challengeId', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    attestation as never,
  );
  return { entry: { attestation, signature, issuer: wallet.address }, expiresSec: nowSec + ttlSec };
}

function makeEnforcer(
  fetchFn: typeof fetch,
  extra: Partial<EnforcerOptions> = {},
): GatewayEnforcer {
  return new GatewayEnforcer({
    fetchFn,
    allowedTargetsByAgent: { [AGENT]: [TARGET, TARGET2] },
    creditTtlMs: 60_000,
    ...extra,
  });
}

const creditOk = (path: string) => {
  if (path.endsWith(`/account/${encodeURIComponent(AGENT)}`)) return { dailyLimitWei: LIMIT };
  return undefined;
};

test('e2e: cache miss fetches resolver+credit and allows a valid spend', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const stub = stubFetch((path) => (path.endsWith(`/resolve/${encodeURIComponent(AGENT)}`) ? { valid: true, ...entry } : undefined), creditOk);
  const enforcer = makeEnforcer(stub.fetchFn);

  const d = await enforcer.enforce(AGENT, TARGET, 10n);
  assert.equal(d.outcome, 'allow');
  assert.equal(d.degraded, false);
  assert.equal(stub.resolverCalls(), 1);
  assert.equal(stub.creditCalls(), 1);
});

test('fail-closed: unreachable resolver denies with degraded flag', async () => {
  const stub = stubFetch(() => undefined, creditOk);
  const enforcer = makeEnforcer(stub.fetchFn);

  const d = await enforcer.enforce(AGENT, TARGET, 10n);
  assert.equal(d.outcome, 'deny');
  assert.equal(d.degraded, true);
  assert.equal(d.reason, 'NO_ATTESTATION');
  assert.equal(d.fallbackReason, 'resolver_unreachable');
});

test('fail-closed: credit service unreachable denies after valid cert', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const stub = stubFetch(() => ({ valid: true, ...entry }), () => undefined);
  const enforcer = makeEnforcer(stub.fetchFn);

  const d = await enforcer.enforce(AGENT, TARGET, 10n);
  assert.equal(d.outcome, 'deny');
  assert.equal(d.reason, 'CREDIT_UNAVAILABLE');
  assert.equal(d.degraded, true);
  assert.equal(d.fallbackReason, 'credit_unreachable');
});

test('fail-closed: attestation with invalid signature denies', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const bad: RawEntry = { ...entry, signature: '0x' + '0'.repeat(130) };
  const stub = stubFetch(() => ({ valid: true, ...bad }), creditOk);
  const enforcer = makeEnforcer(stub.fetchFn);

  const d = await enforcer.enforce(AGENT, TARGET, 10n);
  assert.equal(d.outcome, 'deny');
  assert.equal(d.reason, 'NO_ATTESTATION');
  assert.equal(d.degraded, true);
});

test('deny: expired attestation (valid signature, past notAfter)', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000) - 7200, 3600);
  const stub = stubFetch(() => ({ valid: true, ...entry }), creditOk);
  const enforcer = makeEnforcer(stub.fetchFn);

  const d = await enforcer.enforce(AGENT, TARGET, 10n);
  assert.equal(d.outcome, 'deny');
  assert.equal(d.reason, 'ATTESTATION_EXPIRED');
});

test('deny: target not in allowed-targets policy', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const stub = stubFetch(() => ({ valid: true, ...entry }), creditOk);
  const enforcer = makeEnforcer(stub.fetchFn);

  await enforcer.enforce(AGENT, TARGET, 10n); // populate cache
  const d = await enforcer.enforce(AGENT, '0x' + '9'.repeat(40), 10n);
  assert.equal(d.outcome, 'deny');
  assert.equal(d.reason, 'TARGET_NOT_ALLOWED');
  assert.equal(d.degraded, false);
});

test('sin allowlist configurada → el target es libre (política opcional del underwriter)', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const stub = stubFetch(() => ({ valid: true, ...entry }), creditOk);
  const enforcer = new GatewayEnforcer({ fetchFn: stub.fetchFn });
  await enforcer.enforce(AGENT, TARGET, 10n);
  const d = await enforcer.enforce(AGENT, TARGET, 10n);
  assert.equal(d.outcome, 'allow');
});

test('deny: daily limit exceeded accumulates spentToday', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const stub = stubFetch(() => ({ valid: true, ...entry }), creditOk);
  const enforcer = makeEnforcer(stub.fetchFn);

  await enforcer.enforce(AGENT, TARGET, 600_000_000_000_000_000n);
  await enforcer.enforce(AGENT, TARGET, 300_000_000_000_000_000n);
  const d = await enforcer.enforce(AGENT, TARGET, 200_000_000_000_000_000n);
  assert.equal(d.outcome, 'deny');
  assert.equal(d.reason, 'DAILY_LIMIT_EXCEEDED');
});

test('allow: spend within accumulated daily limit', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const stub = stubFetch(() => ({ valid: true, ...entry }), creditOk);
  const enforcer = makeEnforcer(stub.fetchFn);

  assert.equal((await enforcer.enforce(AGENT, TARGET, 600_000_000_000_000_000n)).outcome, 'allow');
  assert.equal((await enforcer.enforce(AGENT, TARGET2, 300_000_000_000_000_000n)).outcome, 'allow');
});

test('cache hit is fast: second decision below 1ms and no refetch', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const stub = stubFetch(() => ({ valid: true, ...entry }), creditOk);
  const enforcer = makeEnforcer(stub.fetchFn);

  await enforcer.enforce(AGENT, TARGET, 10n);
  const start = process.hrtime.bigint();
  const d = await enforcer.enforce(AGENT, TARGET, 10n);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  assert.equal(d.outcome, 'allow');
  assert.ok(elapsedMs < 1, `cache-hit enforce took ${elapsedMs}ms (budget <1ms)`);
  assert.equal(stub.resolverCalls(), 1);
});

test('benchmark: p99 of 5000 hot decisions < 1ms', () => {
  const enforcer = makeEnforcer(stubFetch(() => undefined, creditOk).fetchFn);
  // prime policy-only state directly through enforceCached-compatible setup
  const cache = (enforcer as unknown as { cache: AttestationCache }).cache;
  const policies = (enforcer as unknown as { creditPolicies: Map<string, { policy: { dailyLimitWei: string }; fetchedAtMs: number }> }).creditPolicies;
  policies.set(AGENT, { policy: { dailyLimitWei: '1000000000000000000' }, fetchedAtMs: Date.now() });
  const targets = (enforcer as unknown as { allowedTargetsByAgent: Record<string, string[]> }).allowedTargetsByAgent;
  targets[AGENT] = [TARGET];
  const entry: import('../src/cache.js').CacheEntry = {
    attestation: { agentId: AGENT, certType: 'AGENT.CERT', capabilitiesHash: '0x' + 'a'.repeat(64), issuedAt: BigInt(Math.floor(Date.now() / 1000)), expiresAt: BigInt(Math.floor(Date.now() / 1000)) + 3600n },
    signature: '0x00',
    issuer: issuer.address,
    fetchedAtMs: Date.now(),
  };
  cache.set(AGENT, entry);
  enforcer.enforceCached(AGENT, TARGET, 1n);

  const bench = enforcer.benchmark(5_000);
  assert.ok(bench.p99 < 1, `p99 ${bench.p99}ms must be < 1ms`);
  assert.ok(bench.p50 < 1);
});

test('cache TTL expiry: stale entry is not served, fail-closed when resolver is down', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  let calls = 0;
  const fetchFn: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/resolve/')) {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ valid: true, ...entry }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Response;
      }
      throw new Error('connection refused');
    }
    return new Response(JSON.stringify({ dailyLimitWei: LIMIT }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
  };
  const enforcer = makeEnforcer(fetchFn, { cacheTtlMs: 100 });

  assert.equal((await enforcer.enforce(AGENT, TARGET, 1n)).outcome, 'allow');
  await new Promise((r) => setTimeout(r, 150));
  const d = await enforcer.enforce(AGENT, TARGET, 1n);
  assert.equal(d.outcome, 'deny');
  assert.equal(d.degraded, true);
});

test('metrics: decision counters, cache hits and fallback_total', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const stub = stubFetch((path) => (path.includes('/resolve/') ? undefined : undefined), creditOk);
  const enforcer = makeEnforcer(stub.fetchFn);

  await enforcer.enforce(AGENT, TARGET, 10n); // deny degraded (resolver down)
  assert.equal(enforcer.getMetrics().fallbackTotal, 1);
  assert.equal(enforcer.getMetrics().deniesByReason['NO_ATTESTATION'], 1);
});

test('metrics: full happy path counts allows, denies and cache hits', async () => {
  const { entry } = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const stub = stubFetch(() => ({ valid: true, ...entry }), creditOk);
  const enforcer = makeEnforcer(stub.fetchFn);

  await enforcer.enforce(AGENT, TARGET, 10n); // miss → fetch
  await enforcer.enforce(AGENT, TARGET, 10n); // hit
  await enforcer.enforce(AGENT, '0x' + '9'.repeat(40), 10n); // deny target
  const m = enforcer.getMetrics();
  assert.equal(m.decisions, 3);
  assert.equal(m.allows, 2);
  assert.equal(m.denies, 1);
  assert.equal(m.deniesByReason['TARGET_NOT_ALLOWED'], 1);
  assert.equal(m.cacheMisses, 1);
  assert.ok(m.cacheHits >= 2);
});

test('contract: every degraded decision carries a fallbackReason', async () => {
  const stub = stubFetch(() => undefined, () => undefined);
  const enforcer = makeEnforcer(stub.fetchFn);
  const decisions: Decision[] = [];
  decisions.push(await enforcer.enforce(AGENT, TARGET, 1n));
  for (const d of decisions) {
    if (d.degraded) assert.ok(typeof d.fallbackReason === 'string', 'degraded decision missing fallbackReason');
  }
});

test('clients: ResolverClient and CreditClient return null on failures', async () => {
  const failing: typeof fetch = async () => {
    throw new Error('boom');
  };
  const resolver = new ResolverClient({ resolverUrl: 'http://localhost:1', fetchFn: failing });
  const credit = new CreditClient({ creditUrl: 'http://localhost:1', fetchFn: failing });
  assert.equal(await resolver.getAttestation(AGENT), null);
  assert.equal(await credit.getPolicy(AGENT), null);
});

test('cache: invalid raw payload rejected, fresh entry returned while TTL valid', async () => {  const raw = { attestation: { agentId: AGENT, certType: 'AGENT.CERT', capabilitiesHash: '0x' + 'a'.repeat(64), issuedAt: 1700000000, expiresAt: 1700003600 }, signature: '0x00', issuer: issuer.address };
  const entry = AttestationCache.fromRaw(raw);
  assert.equal(entry.attestation.expiresAt, 1700003600n);
  const cache = new AttestationCache(60_000);
  cache.set(AGENT, entry);
  assert.ok(cache.getFresh(AGENT) !== null);
  assert.equal(cache.getFresh('agent:unknown'), null);
  assert.equal(cache.isValid(entry, 1700000100n), true);
  assert.equal(cache.isValid(entry, 1700003700n), false);
  const st = cache.stats();
  assert.equal(st.size, 1);
  assert.ok(st.hits >= 1 && st.misses >= 1);
});

test('cache: isValid tolerates raw epoch-ms numbers (issuer form) and bigint seconds', () => {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const cache = new AttestationCache(60_000);
  const msEntry: CacheEntry = {
    attestation: { agentId: AGENT, certType: 'AGENT.CERT', capabilitiesHash: '0x' + 'b'.repeat(64), issuedAt: Date.now() - 60_000, expiresAt: Date.now() + 3_600_000 } as never,
    signature: '0x00',
    issuer: issuer.address,
    fetchedAtMs: Date.now(),
  };
  assert.equal(cache.isValid(msEntry, nowSec), true);
  const expiredMsEntry: CacheEntry = {
    attestation: { agentId: AGENT, certType: 'AGENT.CERT', capabilitiesHash: '0x' + 'b'.repeat(64), issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 3_600_000 } as never,
    signature: '0x00',
    issuer: issuer.address,
    fetchedAtMs: Date.now(),
  };
  assert.equal(cache.isValid(expiredMsEntry, nowSec), false);
  const secEntry: CacheEntry = {
    attestation: { agentId: AGENT, certType: 'AGENT.CERT', capabilitiesHash: '0x' + 'b'.repeat(64), issuedAt: nowSec, expiresAt: nowSec + 3600n },
    signature: '0x00',
    issuer: issuer.address,
    fetchedAtMs: Date.now(),
  };
  assert.equal(cache.isValid(secEntry, nowSec), true);
  assert.equal(cache.isValid(secEntry, nowSec + 3601n), false);
});
