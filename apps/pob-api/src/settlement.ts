import { keccak256, toUtf8Bytes } from 'ethers';

export interface InterchangeSplit {
  gatewayBps: number;
  agentidBps: number;
  gatewayAmountWei: string;
  agentidAmountWei: string;
}

export interface SettlementRecord {
  gatewayId: string;
  tier: number;
  volumeWei: string;
  gatewayBps: number;
  agentidBps: number;
  gatewayAmountWei: string;
  agentidAmountWei: string;
  batchRoot: string;
  day: string;
  settledAt: string;
}

/** gateway-emisor bps por tier (1 = mayor volumen): 60 → 25 decreciente con el tier. */
export const GATEWAY_BPS_BY_TIER = [60, 50, 40, 32, 25] as const;

/** Retención CardCA 0,9% → 0,5% decreciente con volumen ( umbrales en wei, 18 decimales). */
const CARDCA_VOLUME_STEPS: [bigint, number][] = [
  [100_000n * 10n ** 18n, 90],
  [1_000_000n * 10n ** 18n, 80],
  [10_000_000n * 10n ** 18n, 70],
  [100_000_000n * 10n ** 18n, 60],
  [10n ** 27n, 50],
];

export function agentidBpsForVolume(volumeWei: bigint): number {
  for (const [threshold, bps] of CARDCA_VOLUME_STEPS) {
    if (volumeWei <= threshold) return bps;
  }
  return 50;
}

/** Tabla única del blueprint (doc 05 §4): split determinístico del interchange. */
export function splitInterchange(volumeWei: bigint, tier: number): InterchangeSplit {
  if (volumeWei < 0n) throw new Error('volumeCreditoWei must be non-negative');
  const gatewayBps = GATEWAY_BPS_BY_TIER[tier - 1];
  if (gatewayBps === undefined) throw new Error(`tier must be between 1 and ${GATEWAY_BPS_BY_TIER.length}`);
  const agentidBps = agentidBpsForVolume(volumeWei);
  return {
    gatewayBps,
    agentidBps,
    gatewayAmountWei: ((volumeWei * BigInt(gatewayBps)) / 10_000n).toString(),
    agentidAmountWei: ((volumeWei * BigInt(agentidBps)) / 10_000n).toString(),
  };
}

export function settlementLeaf(rec: Omit<SettlementRecord, 'batchRoot'>): string {
  return keccak256(
    toUtf8Bytes(
      JSON.stringify([rec.gatewayId, rec.day, rec.volumeWei, rec.gatewayAmountWei, rec.agentidAmountWei]),
    ),
  );
}

function hashPair(a: string, b: string): string {
  // Pares ordenados lexicográficamente, igual que MerkleProof de OpenZeppelin
  // on-chain (InterchangeSettlement.claim usa MerkleProof.verify).
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return keccak256(Buffer.concat([Buffer.from(lo.slice(2), 'hex'), Buffer.from(hi.slice(2), 'hex')]));
}

function merkleLevel(leaves: string[]): string[] {
  const next: string[] = [];
  for (let i = 0; i < leaves.length; i += 2) {
    const a = leaves[i];
    const b = leaves[i + 1] ?? a; // nodo impar: se duplica, estándar OZ
    next.push(hashPair(a, b));
  }
  return next;
}

function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return keccak256(toUtf8Bytes('empty'));
  let level = [...leaves].sort();
  while (level.length > 1) {
    level = merkleLevel(level);
  }
  return level[0];
}

/** Merkle root (pares ordenados, estándar OpenZeppelin) de los settlements del día. */
export function batchRootForDay(records: Omit<SettlementRecord, 'batchRoot'>[]): string {
  return merkleRoot(records.map(settlementLeaf));
}

/**
 * Merkle proof (índice i) compatible con MerkleProof.verify de OpenZeppelin.
 * Para un nodo sin hermano en el último nivel, el proof contiene el propio nodo
 * duplicado (convención estándar de OZ).
 */
export function merkleProofForIndex(leaves: string[], index: number): string[] {
  if (leaves.length === 0 || index < 0 || index >= leaves.length) throw new Error('index out of range');
  let level = [...leaves].sort();
  let idx = level.indexOf(leaves[index]);
  if (idx === -1) throw new Error('leaf not found');
  const proof: string[] = [];
  while (level.length > 1) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push(level[siblingIdx] ?? level[idx]);
    level = merkleLevel(level);
    idx = Math.floor(idx / 2);
  }
  return proof;
}
