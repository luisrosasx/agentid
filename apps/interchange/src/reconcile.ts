// Reconcile EP-25 Fase 10A: verifica un BatchPayload localmente antes de
// mandarlo on-chain — proof válida contra el batchRoot y split re-derivado
// idéntico al registrado.
import { keccak256 } from 'ethers';
import {
  batchRootForDay,
  settlementLeaf,
  splitInterchange,
  dayToUint,
} from './settlement.js';
import type { BatchPayload, BatchEntry } from './batcher.js';

export interface ReconcileMismatch {
  gatewayId: string;
  reason: string;
}

export interface ReconcileResult {
  ok: boolean;
  mismatched: ReconcileMismatch[];
  checked: number;
}

/** Verificación Merkle local (pares ordenados, misma convención que OZ on-chain). */
export function merkleVerify(leaf: string, proof: string[], root: string): boolean {
  let hash = leaf;
  for (const p of proof) {
    const [lo, hi] = hash <= p ? [hash, p] : [p, hash];
    hash = keccak256(Buffer.concat([Buffer.from(lo.slice(2), 'hex'), Buffer.from(hi.slice(2), 'hex')]));
  }
  return hash === root;
}

function verifyEntry(entry: BatchEntry, expectedRoot: string, day: string, dayUint: string): ReconcileMismatch[] {
  const rec = entry.record;
  const out: ReconcileMismatch[] = [];
  const leaf = settlementLeaf(rec);
  if (leaf !== entry.leaf) out.push({ gatewayId: rec.gatewayId, reason: 'leaf mismatch vs entry.leaf' });
  if (!merkleVerify(leaf, entry.proof, expectedRoot)) {
    out.push({ gatewayId: rec.gatewayId, reason: 'merkle proof inválida contra batchRoot' });
  }
  if (rec.day !== day) out.push({ gatewayId: rec.gatewayId, reason: `day ${rec.day} ≠ ${day}` });
  if (dayToUint(rec.day) !== dayUint) out.push({ gatewayId: rec.gatewayId, reason: `dayUint inconsistente para ${rec.day}` });
  let derived;
  try {
    derived = splitInterchange(BigInt(rec.volumeWei), rec.tier);
  } catch (err) {
    out.push({ gatewayId: rec.gatewayId, reason: `split inválido: ${err instanceof Error ? err.message : String(err)}` });
    return out;
  }
  if (
    derived.gatewayBps !== rec.gatewayBps ||
    derived.agentidBps !== rec.agentidBps ||
    derived.gatewayAmountWei !== rec.gatewayAmountWei ||
    derived.agentidAmountWei !== rec.agentidAmountWei
  ) {
    out.push({ gatewayId: rec.gatewayId, reason: 'split re-derivado difiere del registrado' });
  }
  return out;
}

export function reconcile(payload: BatchPayload): ReconcileResult {
  const mismatched: ReconcileMismatch[] = [];
  const root = batchRootForDay(payload.settlements.map((e) => e.record));
  if (root !== payload.batchRoot) {
    mismatched.push({ gatewayId: '*', reason: 'batchRoot recalculado difiere del payload' });
  }
  const total = payload.settlements.reduce((acc, e) => acc + BigInt(e.record.volumeWei), 0n);
  if (total.toString() !== payload.totalVolumeWei) {
    mismatched.push({ gatewayId: '*', reason: 'totalVolumeWei difiere de la suma de los settlements' });
  }
  const gateways = new Set(payload.settlements.map((e) => e.record.gatewayId)).size;
  if (gateways !== payload.gatewayCount) {
    mismatched.push({ gatewayId: '*', reason: 'gatewayCount difiere del conteo de gatewayIds únicos' });
  }
  for (const entry of payload.settlements) {
    mismatched.push(...verifyEntry(entry, payload.batchRoot, payload.day, payload.dayUint));
  }
  return { ok: mismatched.length === 0, mismatched, checked: payload.settlements.length };
}
