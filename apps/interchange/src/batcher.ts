// Batcher EP-25 Fase 10A: toma los settlements de un día (de pob-api) y
// construye el payload listo para `settleDay` del contrato InterchangeSettlement.
import {
  batchRootForDay,
  dayToUint,
  merkleProofForIndex,
  settlementLeaf,
  type SettlementRecord,
} from './settlement.js';

export interface BatchEntry {
  record: SettlementRecord;
  leaf: string;
  leafHash: string;
  proof: string[];
}

export interface BatchPayload {
  day: string;
  dayUint: string;
  batchRoot: string;
  totalVolumeWei: string;
  gatewayCount: number;
  settlements: BatchEntry[];
}

export function buildBatch(records: SettlementRecord[]): BatchPayload {
  if (records.length === 0) throw new Error('no settlements for day');
  const days = new Set(records.map((r) => r.day));
  if (days.size > 1) throw new Error(`records span multiple days: ${[...days].join(',')}`);
  const day = records[0]!.day;
  const leaves = records.map(settlementLeaf);
  const entries: BatchEntry[] = records.map((record, i) => ({
    record,
    leaf: leaves[i]!,
    leafHash: settlementLeafToHash(leaves[i]!),
    proof: merkleProofForIndex(leaves, i),
  }));
  const totalVolumeWei = records.reduce((acc, r) => acc + BigInt(r.volumeWei), 0n);
  return {
    day,
    dayUint: dayToUint(day),
    batchRoot: batchRootForDay(records),
    totalVolumeWei: totalVolumeWei.toString(),
    gatewayCount: new Set(records.map((r) => r.gatewayId)).size,
    settlements: entries,
  };
}

function settlementLeafToHash(leaf: string): string {
  // El leaf ya es un keccak256; leafHash lo indexa (claim marca claimed[day][leafHash]).
  return leaf;
}

export interface SettlementsFetcher {
  (day: string): Promise<SettlementRecord[]>;
}

/** Fetcher por defecto: GET /settlements/:day de pob-api. */
export function pobApiFetcher(baseUrl: string): SettlementsFetcher {
  return async (day) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/settlements/${day}`);
    if (!res.ok) throw new Error(`pob-api /settlements/${day} → ${res.status}`);
    const body = (await res.json()) as { settlements: SettlementRecord[] };
    return body.settlements;
  };
}

export async function buildBatchForDay(day: string, fetchSettlements: SettlementsFetcher): Promise<BatchPayload> {
  const records = await fetchSettlements(day);
  return buildBatch(records);
}
