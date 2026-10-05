import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMerkleTree, verifyZkAttestation, ZK_LEVELS, zerosTree, type ZkAttestationInput } from '../src/zk.js';
import { buildApp } from '../src/server.js';
import { MemoryRecordsStore, type ZkAttestRecord } from '../src/records.js';
import type { FastifyInstance } from 'fastify';

function addr(n: number): Uint8Array {
  const a = new Uint8Array(20);
  a[0] = (n >> 8) & 0xff;
  a[1] = n & 0xff;
  a[2] = 0xab;
  return a;
}

function hex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex');
}

function makeInput(overrides: Partial<ZkAttestationInput> = {}): { input: ZkAttestationInput; addrs: Uint8Array[] } {
  const addrs = [addr(1010), addr(5000), addr(9001), addr(10201)];
  const { root, proofs } = buildMerkleTree(addrs);
  const input: ZkAttestationInput = {
    root,
    identities: addrs,
    paths: proofs,
    weak: [false, false, false, false],
    weights: [100, 100, 100, 100],
    minK: 4,
    minWeight: 400,
    ...overrides,
  };
  return { input, addrs };
}

test('zerosTree construye la escalera de subárboles de ceros', () => {
  const zeros = zerosTree(ZK_LEVELS);
  assert.equal(zeros.length, ZK_LEVELS + 1);
  assert.equal(zeros[0].length, 32);
  assert.ok(!Buffer.from(zeros[0]).equals(Buffer.from(zeros[1])));
});

test('buildMerkleTree + verifyZkAttestation: happy path', () => {
  const { input } = makeInput();
  assert.deepEqual(verifyZkAttestation(input), { ok: true });
});

test('verifyZkAttestation rechaza identidad duplicada', () => {
  const { input, addrs } = makeInput();
  const dup = [addrs[0], addrs[0], addrs[2], addrs[3]];
  const rebuilt = buildMerkleTree(dup);
  assert.equal(verifyZkAttestation({ ...input, identities: dup, paths: rebuilt.proofs, root: rebuilt.root }).ok, false);
  const res = verifyZkAttestation({ ...input, identities: [addrs[0], addrs[0], addrs[2], addrs[3]] });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /duplicate/);
});

test('verifyZkAttestation rechaza prueba Merkle corrupta', () => {
  const { input } = makeInput();
  const corrupted = input.paths.map((p) => ({ siblings: p.siblings.map(() => new Uint8Array(32)), selectors: p.selectors }));
  const res = verifyZkAttestation({ ...input, paths: corrupted });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /membership/);
});

test('verifyZkAttestation rechaza minK no alcanzado', () => {
  const { input } = makeInput({ minK: 5 });
  const res = verifyZkAttestation(input);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /min_k/);
});

test('verifyZkAttestation rechaza identidad fuera del árbol', () => {
  const { input } = makeInput();
  const foreign = [addr(7777), addr(8888), addr(9999), addr(1234)];
  const res = verifyZkAttestation({ ...input, identities: foreign });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /membership/);
});

test('verifyZkAttestation rechaza ventana malformada y min_weight insuficiente con débiles', () => {
  const { input } = makeInput();
  assert.match(verifyZkAttestation({ ...input, window: { start: 2000, end: 1000 } }).reason ?? '', /window/);
  const allWeak = verifyZkAttestation({ ...input, weak: [true, true, true, true], weights: [10, 10, 10, 10] });
  assert.equal(allWeak.ok, false);
  assert.match(allWeak.reason ?? '', /min_weight/);
});

test('verifyZkAttestation pondera débiles al 10%', () => {
  const { input } = makeInput({ minWeight: 250 });
  const res = verifyZkAttestation({ ...input, weak: [true, false, false, false] });
  assert.deepEqual(res, { ok: true });
});

async function buildTestApp() {
  const records = new MemoryRecordsStore();
  const app: FastifyInstance = await buildApp({ records });
  return { app, records };
}

interface ZkCounterparty {
  address: string;
  merklePath: { siblings: string[]; selectors: boolean[] };
  weak: boolean;
  weight?: number;
}

function bodyFromInput(input: ZkAttestationInput, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const counterparties: ZkCounterparty[] = input.identities.map((id, i) => ({
    address: hex(id),
    merklePath: {
      siblings: input.paths[i].siblings.map(hex),
      selectors: input.paths[i].selectors,
    },
    weak: input.weak[i],
    weight: input.weights[i],
  }));
  return {
    agentId: 'agent-zk',
    root: hex(input.root),
    minK: input.minK,
    minWeight: input.minWeight,
    counterparties,
    ...overrides,
  };
}

test('/zk-attest: 201 y NO persiste contrapartes en claro', async () => {
  const { app, records } = await buildTestApp();
  try {
    const { input } = makeInput();
    const res = await app.inject({ method: 'POST', url: '/zk-attest', payload: bodyFromInput(input) });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.validAttestations, 4);
    assert.equal(body.root, hex(input.root));
    assert.match(body.attestationHash, /^0x[0-9a-fA-F]{64}$/);

    const log: ZkAttestRecord[] = await records.listZkAttestations('agent-zk');
    assert.equal(log.length, 1);
    const dumped = JSON.stringify(log);
    for (const id of input.identities) {
      assert.equal(dumped.toLowerCase().includes(hex(id).slice(2)), false, 'contraparte persistida en claro');
    }
    assert.ok(dumped.includes(log[0].root));
  } finally {
    await app.close();
  }
});

test('/zk-attest: 400 en body malformado y atestación inválida', async () => {
  const { app } = await buildTestApp();
  try {
    const { input } = makeInput();
    const missing = await app.inject({ method: 'POST', url: '/zk-attest', payload: { agentId: 'a', root: hex(input.root) } });
    assert.equal(missing.statusCode, 400);
    const badAddr = await app.inject({
      method: 'POST',
      url: '/zk-attest',
      payload: bodyFromInput(input, { counterparties: [{ address: '0x1234', merklePath: { siblings: [], selectors: [] }, weak: false }] }),
    });
    assert.equal(badAddr.statusCode, 400);
    const invalid = await app.inject({
      method: 'POST',
      url: '/zk-attest',
      payload: bodyFromInput(input, { counterparties: bodyFromInput(input).counterparties.map((c, i) => ({ ...(c as ZkCounterparty), weak: i === 0 })) }),
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(String(invalid.json().reason ?? ''), /min_weight/);
  } finally {
    await app.close();
  }
});

test('/cross-attest con POB_REQUIRE_ZK=true: 409 sin atestación, normal con atestación válida', async () => {
  const prev = process.env['POB_REQUIRE_ZK'];
  process.env['POB_REQUIRE_ZK'] = 'true';
  const { app, records } = await buildTestApp();
  try {
    const blocked = await app.inject({ method: 'POST', url: '/cross-attest', payload: { agentId: 'agent-zk' } });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error, 'zk-required');
    assert.ok(blocked.json().hint);

    const { input } = makeInput();
    const attest = await app.inject({ method: 'POST', url: '/zk-attest', payload: bodyFromInput(input) });
    assert.equal(attest.statusCode, 201);

    const ok = await app.inject({ method: 'POST', url: '/cross-attest', payload: { agentId: 'agent-zk' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().agentId, 'agent-zk');
    assert.equal(await records.hasValidZkAttestation('agent-zk'), true);
  } finally {
    if (prev === undefined) delete process.env['POB_REQUIRE_ZK'];
    else process.env['POB_REQUIRE_ZK'] = prev;
    await app.close();
  }
});

test('/cross-attest con POB_REQUIRE_ZK=false no exige atestación', async () => {
  const { app } = await buildTestApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/cross-attest', payload: { agentId: 'agent-zk' } });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('/healthz expone zkRequired', async () => {
  const prev = process.env['POB_REQUIRE_ZK'];
  const { app } = await buildTestApp();
  try {
    process.env['POB_REQUIRE_ZK'] = 'true';
    const on = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(on.json().zkRequired, true);
    process.env['POB_REQUIRE_ZK'] = 'false';
    const off = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(off.json().zkRequired, false);
  } finally {
    if (prev === undefined) delete process.env['POB_REQUIRE_ZK'];
    else process.env['POB_REQUIRE_ZK'] = prev;
    await app.close();
  }
});
