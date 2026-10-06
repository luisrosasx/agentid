import {
  Signer,
  TypedDataEncoder,
  concat,
  hexlify,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from 'ethers';

import {
  CARDCA_DOMAIN,
  getReceiptTypes,
  type BilateralReceiptMessage,
} from '@cardca/schemas';

export { CARDCA_DOMAIN };

export type { BilateralReceiptMessage };

export interface SignedBilateralReceipt {
  message: BilateralReceiptMessage;
  signature: string;
  signer: string;
}

function assertReceiptFormat(receipt: BilateralReceiptMessage): void {
  if (typeof receipt.agentId !== 'string' || receipt.agentId.length === 0) {
    throw new Error('agentId must be a non-empty string');
  }
  if (typeof receipt.counterpartyId !== 'string' || receipt.counterpartyId.length === 0) {
    throw new Error('counterpartyId must be a non-empty string');
  }
  if (typeof receipt.counterpartyStakeRoot !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(receipt.counterpartyStakeRoot)) {
    throw new Error('counterpartyStakeRoot must be a 32-byte hex string');
  }
  if (typeof receipt.a2aTaskHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(receipt.a2aTaskHash)) {
    throw new Error('a2aTaskHash must be a 32-byte hex string');
  }
  if (!Number.isInteger(receipt.outcome) || receipt.outcome < 0 || receipt.outcome > 255) {
    throw new Error('outcome must be an integer in [0, 255]');
  }
  if (typeof receipt.digest !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(receipt.digest)) {
    throw new Error('digest must be a 32-byte hex string');
  }
  if (typeof receipt.timestamp !== 'bigint' || receipt.timestamp < 0n) {
    throw new Error('timestamp must be a non-negative bigint');
  }
}

export async function signReceipt(
  receipt: BilateralReceiptMessage,
  signer: Signer,
): Promise<SignedBilateralReceipt> {
  assertReceiptFormat(receipt);
  const signature = await signer.signTypedData(
    { name: CARDCA_DOMAIN.name, version: CARDCA_DOMAIN.version },
    getReceiptTypes(),
    { ...receipt },
  );
  const address = await signer.getAddress();
  return { message: { ...receipt }, signature, signer: address };
}

export function verifyReceipt(
  signed: SignedBilateralReceipt,
  expectedSigner?: string,
): boolean {
  assertReceiptFormat(signed.message);
  const recovered = verifyTypedData(
    { name: CARDCA_DOMAIN.name, version: CARDCA_DOMAIN.version },
    getReceiptTypes(),
    { ...signed.message },
    signed.signature,
  );
  if (expectedSigner) {
    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  }
  return recovered.toLowerCase() === signed.signer.toLowerCase();
}

export function receiptDigest(receipt: BilateralReceiptMessage): string {
  assertReceiptFormat(receipt);
  return TypedDataEncoder.hash(
    { name: CARDCA_DOMAIN.name, version: CARDCA_DOMAIN.version },
    getReceiptTypes(),
    { ...receipt },
  );
}

function pairHash(a: string, b: string): string {
  return keccak256(concat([a, b]));
}

/**
 * Árbol de Merkle sobre hojas ya hasheadas (misma forma que usa el anchor:
 * par de hojas = keccak(left || right); hoja impar se duplica).
 */
function buildLevels(leaves: string[]): string[][] {
  let level = leaves.length === 1 ? [pairHash(leaves[0], leaves[0])] : [...leaves];
  const levels: string[][] = [level];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(pairHash(level[i], right));
    }
    level = next;
    levels.push(level);
  }
  return levels;
}

export function merkleRootFromLeaves(leaves: string[]): string {
  if (leaves.length === 0) return keccak256(toUtf8Bytes('cardca:empty'));
  const levels = buildLevels(leaves);
  return hexlify(levels[levels.length - 1][0]);
}

export interface MerkleProofStep {
  /** Hash hermano en ese nivel. */
  sibling: string;
  /** 'left' = el hermano va a la izquierda en el hash del par. */
  position: 'left' | 'right';
}

export function merkleProofFromLeaves(leaves: string[], leafHash: string): MerkleProofStep[] | null {
  const idx = leaves.indexOf(leafHash);
  if (idx === -1) return null;
  if (leaves.length === 1) {
    // raíz de árbol de una sola hoja = pairHash(hoja, hoja)
    return [{ sibling: hexlify(leafHash), position: 'right' }];
  }
  const levels = buildLevels(leaves);
  const proof: MerkleProofStep[] = [];
  let i = idx;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const isRight = i % 2 === 1;
    const siblingIdx = isRight ? i - 1 : (i + 1 < level.length ? i + 1 : i);
    proof.push({ sibling: hexlify(level[siblingIdx]), position: isRight ? 'left' : 'right' });
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyMerkleProof(leafHash: string, proof: MerkleProofStep[], root: string): boolean {
  let node = leafHash;
  for (const step of proof) {
    node = step.position === 'left' ? pairHash(step.sibling, node) : pairHash(node, step.sibling);
  }
  return node.toLowerCase() === root.toLowerCase();
}

export function merkleRoot(receipts: BilateralReceiptMessage[]): string {
  if (receipts.length === 0) {
    return keccak256(toUtf8Bytes('CardCA:empty-receipt-set'));
  }
  let level: string[] = receipts.map((r) => receiptDigest(r));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(pairHash(level[i], level[i]));
      } else {
        next.push(pairHash(level[i], level[i + 1]));
      }
    }
    level = next;
  }
  return hexlify(level[0]);
}
