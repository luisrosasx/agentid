import { TypedDataEncoder, concat, hexlify, keccak256, toUtf8Bytes, verifyTypedData, } from 'ethers';
import { AGENT_ID_DOMAIN, getReceiptTypes, } from '@agentid/schemas';
export { AGENT_ID_DOMAIN };
function assertReceiptFormat(receipt) {
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
export async function signReceipt(receipt, signer) {
    assertReceiptFormat(receipt);
    const signature = await signer.signTypedData({ name: AGENT_ID_DOMAIN.name, version: AGENT_ID_DOMAIN.version }, getReceiptTypes(), { ...receipt });
    const address = await signer.getAddress();
    return { message: { ...receipt }, signature, signer: address };
}
export function verifyReceipt(signed, expectedSigner) {
    assertReceiptFormat(signed.message);
    const recovered = verifyTypedData({ name: AGENT_ID_DOMAIN.name, version: AGENT_ID_DOMAIN.version }, getReceiptTypes(), { ...signed.message }, signed.signature);
    if (expectedSigner) {
        return recovered.toLowerCase() === expectedSigner.toLowerCase();
    }
    return recovered.toLowerCase() === signed.signer.toLowerCase();
}
export function receiptDigest(receipt) {
    assertReceiptFormat(receipt);
    return TypedDataEncoder.hash({ name: AGENT_ID_DOMAIN.name, version: AGENT_ID_DOMAIN.version }, getReceiptTypes(), { ...receipt });
}
function pairHash(a, b) {
    return keccak256(concat([a, b]));
}
export function merkleRoot(receipts) {
    if (receipts.length === 0) {
        return keccak256(toUtf8Bytes('AGENT.ID:empty-receipt-set'));
    }
    let level = receipts.map((r) => receiptDigest(r));
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            if (i + 1 === level.length) {
                next.push(pairHash(level[i], level[i]));
            }
            else {
                next.push(pairHash(level[i], level[i + 1]));
            }
        }
        level = next;
    }
    return hexlify(level[0]);
}
