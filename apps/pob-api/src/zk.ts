import { keccak256, getBytes } from 'ethers';

export const ZK_LEVELS = 10;
export const ZK_LEAVES = 1 << ZK_LEVELS;

export interface MerklePath {
  siblings: Uint8Array[];
  selectors: boolean[];
}

export interface ZkAttestationInput {
  root: Uint8Array;
  identities: Uint8Array[];
  paths: MerklePath[];
  weak: boolean[];
  weights: number[];
  minK: number;
  minWeight: number;
  window?: { start: number; end: number };
}

const zerosCache = new Map<number, Uint8Array[]>();

export function keccakLeaf(addr: Uint8Array): Uint8Array {
  if (addr.length !== 20) throw new Error('leaf address must be 20 bytes');
  return Buffer.from(getBytes(keccak256(Buffer.from(addr))));
}

export function keccakNode(buf: Uint8Array): Uint8Array {
  return Buffer.from(getBytes(keccak256(Buffer.from(buf))));
}

export function zerosTree(levels: number): Uint8Array[] {
  const cached = zerosCache.get(levels);
  if (cached) return cached;
  const zeros: Uint8Array[] = [keccakLeaf(new Uint8Array(20))];
  for (let h = 1; h <= levels; h++) zeros[h] = keccakNode(concat32(zeros[h - 1], zeros[h - 1]));
  zerosCache.set(levels, zeros);
  return zeros;
}

function concat32(a: Uint8Array, b: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(a), Buffer.from(b)]);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

function nodeAt(
  h: number,
  pos0: number,
  leafAddrs: (Uint8Array | null)[],
  zeros: Uint8Array[],
): Uint8Array {
  if (h === 0) {
    const a = leafAddrs[pos0];
    return a ? keccakLeaf(a) : zeros[0];
  }
  const span = 1 << h;
  const l = nodeAt(h - 1, pos0, leafAddrs, zeros);
  const r = nodeAt(h - 1, pos0 + span / 2, leafAddrs, zeros);
  if (bytesEqual(l, zeros[h - 1]) && bytesEqual(r, zeros[h - 1])) return zeros[h];
  return keccakNode(concat32(l, r));
}

export function buildMerkleTree(
  addresses: Uint8Array[],
  leaves: number = ZK_LEAVES,
): { root: Uint8Array; proofs: MerklePath[] } {
  if (addresses.length > leaves) throw new Error('too many addresses for tree size');
  const levels = Math.log2(leaves);
  if (!Number.isInteger(levels)) throw new Error('leaves must be a power of two');
  const zeros = zerosTree(levels);
  const leafAddrs: (Uint8Array | null)[] = new Array(leaves).fill(null);
  addresses.forEach((a, i) => {
    leafAddrs[i] = a;
  });
  const proofs: MerklePath[] = Array.from({ length: addresses.length }, () => ({ siblings: [], selectors: [] }));
  const walk = (h: number, pos0: number): void => {
    if (h === 0) return;
    const span = 1 << h;
    const half = span / 2;
    const l = nodeAt(h - 1, pos0, leafAddrs, zeros);
    const r = nodeAt(h - 1, pos0 + half, leafAddrs, zeros);
    walk(h - 1, pos0);
    walk(h - 1, pos0 + half);
    for (let k = 0; k < half; k++) {
      const left = proofs[pos0 + k];
      if (left) {
        left.siblings.push(r);
        left.selectors.push(false);
      }
      const right = proofs[pos0 + half + k];
      if (right) {
        right.siblings.push(l);
        right.selectors.push(true);
      }
    }
  };
  const root = nodeAt(levels, 0, leafAddrs, zeros);
  walk(levels, 0);
  return { root, proofs };
}

// Espejo del orden de asserts de zk/circuits/dc_subbatch/src/main.nr:
// ventana → unicidad pairwise → pertenencia Merkle keccak → min_k → ponderación de débiles
export function verifyZkAttestation(att: ZkAttestationInput): { ok: boolean; reason?: string } {
  if (att.window) {
    if (!(att.window.start < att.window.end)) return { ok: false, reason: 'window_start must be < window_end' };
  }
  if (att.identities.length !== att.paths.length || att.identities.length !== att.weak.length) {
    return { ok: false, reason: 'identities, paths and weak flags must have the same length' };
  }
  if (att.identities.length === 0) return { ok: false, reason: 'at least one counterparty required' };
  for (let i = 0; i < att.identities.length; i++) {
    for (let j = i + 1; j < att.identities.length; j++) {
      if (bytesEqual(att.identities[i], att.identities[j])) {
        return { ok: false, reason: `duplicate counterparty identity at positions ${i} and ${j}` };
      }
    }
  }
  let totalWeight = 0;
  for (let i = 0; i < att.identities.length; i++) {
    let h = keccakLeaf(att.identities[i]);
    const path = att.paths[i];
    for (let l = 0; l < path.siblings.length; l++) {
      const s = path.siblings[l];
      h = path.selectors[l] ? keccakNode(concat32(s, h)) : keccakNode(concat32(h, s));
    }
    if (!bytesEqual(h, att.root)) return { ok: false, reason: `merkle membership failed for counterparty ${i}` };
    const w = att.weights[i] ?? 0;
    totalWeight += att.weak[i] ? Math.floor(w / 10) : w;
  }
  if (att.identities.length < att.minK) return { ok: false, reason: 'min_k not reached' };
  if (totalWeight < att.minWeight) return { ok: false, reason: 'min_weight not reached' };
  return { ok: true };
}
