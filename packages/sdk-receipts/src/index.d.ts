import { Signer } from 'ethers';
import { AGENT_ID_DOMAIN, type BilateralReceiptMessage } from '@agentid/schemas';
export { AGENT_ID_DOMAIN };
export type { BilateralReceiptMessage };
export interface SignedBilateralReceipt {
    message: BilateralReceiptMessage;
    signature: string;
    signer: string;
}
export declare function signReceipt(receipt: BilateralReceiptMessage, signer: Signer): Promise<SignedBilateralReceipt>;
export declare function verifyReceipt(signed: SignedBilateralReceipt, expectedSigner?: string): boolean;
export declare function receiptDigest(receipt: BilateralReceiptMessage): string;
export declare function merkleRoot(receipts: BilateralReceiptMessage[]): string;
