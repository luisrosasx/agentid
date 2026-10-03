import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toUtf8Bytes } from 'ethers';
import { crossAttest, receiptDigest, TIMESTAMP_SKEW_MS, type ContradictionType } from '../src/cross-attest.js';
import type { StoredReceipt } from '../src/receipts.js';

// PRNG determinístico (mulberry32) — suite reproducible con seed fija.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Dirección sintética determinística (Wallet.createRandom es lento en volumen).
let uid = 0;
function addr(seed: string): string {
  return keccak256(toUtf8Bytes(seed)).slice(0, 42);
}

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function mkPair(
  rand: () => number,
  i: number,
  overridesAgent: Partial<StoredReceipt> = {},
): { agent: StoredReceipt; mirror: StoredReceipt } {
  const nonce = `task-${i}`;
  const counterparty = addr(`cp-${i}`);
  const outcome = rand() < 0.5 ? 'positive' : 'negative';
  const base = NOW - Math.floor(rand() * 1000);
  const agent: StoredReceipt = {
    agentId: `agent-${i}`,
    counterparty,
    outcome,
    nonce,
    issuedAt: new Date(base).toISOString(),
    signer: addr(`signer-${++uid}`),
    receivedAt: new Date(NOW).toISOString(),
    ...overridesAgent,
  };
  const mirror: StoredReceipt = {
    ...agent,
    agentId: counterparty,
    counterparty: `agent-${i}`,
    issuedAt: new Date(base + Math.floor(rand() * 30_000)).toISOString(),
  };
  return { agent, mirror };
}

interface InjectedCase {
  kind: ContradictionType;
  agentReceipts: StoredReceipt[];
  mirrorReceipts: StoredReceipt[];
}

test('10k casos sintéticos determinísticos: 0 falsos positivos y 100% de detección', () => {
  const rand = mulberry32(20260115);
  const CLASSES: ContradictionType[] = [
    'outcome-divergence',
    'timestamp-skew',
    'digest-divergence',
    'replay',
    'unilateral-anchor',
  ];
  let falsePositives = 0;
  let detected = 0;
  let injectedCases = 0;
  for (let i = 0; i < 10_000; i++) {
    if (i % 2 === 0) {
      // flota limpia: par espejo consistente
      const { agent, mirror } = mkPair(rand, i);
      const { verdict } = crossAttest([agent], [mirror]);
      if (verdict !== 'clean') falsePositives += 1;
      continue;
    }
    injectedCases += 1;
    const kind = CLASSES[i % 5];
    const { agent, mirror } = mkPair(rand, i);
    let caseData: InjectedCase;
    switch (kind) {
      case 'outcome-divergence':
        caseData = { kind, agentReceipts: [agent], mirrorReceipts: [{ ...mirror, outcome: mirror.outcome === 'positive' ? 'negative' : 'positive' }] };
        break;
      case 'timestamp-skew':
        caseData = {
          kind,
          agentReceipts: [agent],
          mirrorReceipts: [{ ...mirror, issuedAt: new Date(Date.parse(agent.issuedAt) + TIMESTAMP_SKEW_MS + 30_000).toISOString() }],
        };
        break;
      case 'digest-divergence':
        caseData = { kind, agentReceipts: [agent, { ...agent, outcome: agent.outcome === 'positive' ? 'negative' : 'positive' }], mirrorReceipts: [mirror] };
        break;
      case 'replay':
        caseData = { kind, agentReceipts: [agent, { ...agent, counterparty: addr(`replay-${i}`) }], mirrorReceipts: [mirror] };
        break;
      case 'unilateral-anchor':
        caseData = { kind, agentReceipts: [agent], mirrorReceipts: [] };
        break;
    }
    const report = crossAttest(caseData.agentReceipts, caseData.mirrorReceipts);
    if (report.verdict !== 'contested' || !report.contradictions.some((c) => c.type === kind)) {
      detected += 0;
      assert.fail(`caso ${i} (${kind}): contradicción inyectada no detectada`);
    } else {
      detected += 1;
    }
    // la evidencia debe ser determinística y reproducible
    const again = crossAttest(caseData.agentReceipts, caseData.mirrorReceipts);
    assert.equal(again.contradictions[0]?.evidenceHash, report.contradictions[0]?.evidenceHash);
  }
  assert.equal(falsePositives, 0, 'falsos positivos en flota limpia');
  assert.equal(detected, injectedCases, 'detección de contradicciones inyectadas');
  assert.equal(injectedCases, 5000);
});

test('receiptDigest es determinístico y sensible al contenido', () => {
  const rand = mulberry32(7);
  const { agent } = mkPair(rand, 1);
  assert.equal(receiptDigest(agent), receiptDigest(agent));
  assert.notEqual(receiptDigest(agent), receiptDigest({ ...agent, outcome: 'negative' }));
});

test('verdict clean en flota con muchos pares honestos', () => {
  const rand = mulberry32(99);
  const agents: StoredReceipt[] = [];
  const mirrors: StoredReceipt[] = [];
  for (let i = 0; i < 200; i++) {
    const { agent, mirror } = mkPair(rand, 1000 + i);
    agents.push(agent);
    mirrors.push(mirror);
  }
  for (const a of agents) {
    const report = crossAttest([a], mirrors);
    assert.equal(report.verdict, 'clean');
  }
});
