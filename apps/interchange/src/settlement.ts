// Réplica de apps/pob-api/src/settlement.ts (EP-25).
//
// NOTA DE PARIDAD: esta copia existe porque pob-api no exporta su módulo de
// settlement como package. El test `test/parity.test.ts` compara esta réplica
// contra el original de pob-api (mismos vectores de split y mismo batchRoot)
// para detectar divergencias.
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

export const GATEWAY_BPS_BY_TIER = [60, 50, 40, 32, 25] as const;

const AGENTID_VOLUME_STEPS: [bigint, number][] = [
  [100_000n * 10n ** 18n, 90],
  [1_000_000n * 10n ** 18n, 80],
  [10_000_000n * 10n ** 18n, 70],
  [100_000_000n * 10n ** 18n, 60],
  [10n ** 27n, 50],
];

export function agentidBpsForVolume(volumeWei: bigint): number {
  for (const [threshold, bps] of AGENTID_VOLUME_STEPS) {
    if (volumeWei <= threshold) return bps;
  }
  return 50;
}

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

/** Leaf compartido TS↔Solidity: keccak(JSON.stringify([gatewayId, day, volumeWei, gatewayAmountWei, agentidAmountWei])). */
export function settlementLeaf(rec: Omit<SettlementRecord, 'batchRoot'>): string {
  return keccak256(
    toUtf8Bytes(
      JSON.stringify([rec.gatewayId, rec.day, rec.volumeWei, rec.gatewayAmountWei, rec.agentidAmountWei]),
    ),
  );
}

function hashPair(a: string, b: string): string {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return keccak256(Buffer.concat([Buffer.from(lo.slice(2), 'hex'), Buffer.from(hi.slice(2), 'hex')]));
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return keccak256(toUtf8Bytes('empty'));
  let level = [...leaves].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hashPair(level[i], level[i + 1] ?? level[i]));
    }
    level = next;
  }
  return level[0];
}

export function merkleProofForIndex(leaves: string[], index: number): string[] {
  if (leaves.length === 0 || index < 0 || index >= leaves.length) throw new Error('index out of range');
  const level = [...leaves].sort();
  let idx = level.indexOf(leaves[index]);
  if (idx === -1) throw new Error('leaf not found');
  const proof: string[] = [];
  while (level.length > 1) {
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push(level[sib] ?? level[idx]);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hashPair(level[i], level[i + 1] ?? level[i]));
    }
    level.splice(0, level.length, ...next);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function batchRootForDay(records: Omit<SettlementRecord, 'batchRoot'>[]): string {
  return merkleRoot(records.map(settlementLeaf));
}

/** 'YYYY-MM-DD' → uint256 de día on-chain (YYYYMMDD). */
export function dayToUint(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`day must be YYYY-MM-DD: ${day}`);
  return day.replaceAll('-', '');
}
