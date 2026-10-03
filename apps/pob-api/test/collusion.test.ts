import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toUtf8Bytes } from 'ethers';
import { analyzeCollusion } from '../src/collusion.js';
import type { StoredReceipt } from '../src/receipts.js';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const AGE = NOW - 24 * 3600 * 1000; // dentro de la ventana de 7 días

/** Dirección sintética determinística (evita Wallet.createRandom, lento en volumen). */
let uid = 0;
function addr(seed: string): string {
  return keccak256(toUtf8Bytes(seed)).slice(0, 42);
}

function mk(agentId: string, counterparty: string, nonce: string, issuedAt = AGE): StoredReceipt {
  return {
    agentId,
    counterparty,
    outcome: 'positive',
    nonce,
    issuedAt: new Date(issuedAt).toISOString(),
    signer: addr(`signer-${nonce}`),
    receivedAt: new Date(NOW).toISOString(),
  };
}

test('granja sintética de 400 cuentas calificándose mutuamente → collusionRisk high', () => {
  const all: StoredReceipt[] = [];
  const ids = Array.from({ length: 400 }, (_, i) => addr(`id-${++uid}`));
  for (let i = 0; i < 400; i++) {
    for (let j = 0; j < 400; j++) {
      if (i === j) continue;
      all.push(mk(ids[i], ids[j], `n-${i}-${j}`));
    }
  }
  const report = analyzeCollusion(ids[0], all.filter((r) => r.agentId === ids[0]), all, NOW);
  assert.equal(report.collusionRisk, 'high');
  assert.ok(report.signals.reciprocityCycles >= 3);
});

test('flota limpia de 400 (contrapartes únicas sin reciprocidad) → none o low', () => {
  const all: StoredReceipt[] = [];
  const agent = addr(`id-${++uid}`);
  for (let i = 0; i < 400; i++) {
    const cp = addr(`id-${++uid}`);
    all.push(mk(agent, cp, `n-clean-${i}`));
    // los supuestos `mk` de las contrapartes no califican de vuelta (sin espejo)
    all.push(mk(`cp-${i}`, addr(`id-${++uid}`), `n-cp-${i}`));
  }
  const report = analyzeCollusion(agent, all.filter((r) => r.agentId === agent), all, NOW);
  assert.ok(report.collusionRisk === 'none' || report.collusionRisk === 'low');
  assert.equal(report.signals.reciprocityCycles, 0);
  assert.ok(report.signals.top1Share <= 0.5);
  assert.ok(report.signals.hhi < 0.25);
});

test('concentración: top-1 contraparte > 50% → high', () => {
  const cp = addr(`id-${++uid}`);
  const others = Array.from({ length: 3 }, () => addr(`id-${++uid}`));
  const receipts = [
    ...Array.from({ length: 60 }, (_, i) => mk('agent-a', cp, `c-${i}`)),
    ...others.map((o, i) => mk('agent-a', o, `o-${i}`)),
  ];
  const report = analyzeCollusion('agent-a', receipts, receipts, NOW);
  assert.ok(report.signals.top1Share > 0.5);
  assert.equal(report.collusionRisk, 'high');
});

test('reciprocidad fuera de la ventana de 7 días no cuenta como ciclo', () => {
  const a = addr(`id-${++uid}`);
  const b = addr(`id-${++uid}`);
  const old = NOW - 8 * 24 * 3600 * 1000;
  const receipts = [mk(a, b, 'n1', old), mk(b, a, 'n2', old)];
  const report = analyzeCollusion(a, receipts.filter((r) => r.agentId === a), receipts, NOW);
  assert.equal(report.signals.reciprocityCycles, 0);
  assert.equal(report.collusionRisk, 'none');
});

test('reciprocidad dentro de la ventana cuenta un ciclo y marca low', () => {
  const a = addr(`id-${++uid}`);
  const b = addr(`id-${++uid}`);
  const others = Array.from({ length: 3 }, () => addr(`o-${++uid}`));
  const receipts = [
    mk(a, b, 'n1'),
    mk(b, a, 'n2'),
    ...others.map((o, i) => mk(a, o, `o-${i}`)),
  ];
  const report = analyzeCollusion(a, receipts.filter((r) => r.agentId === a), receipts, NOW);
  assert.equal(report.signals.reciprocityCycles, 1);
  assert.ok(report.signals.top1Share <= 0.5);
  assert.equal(report.collusionRisk, 'low');
});
