import { Signer } from 'ethers';
import { CARDCA_DOMAIN, type BilateralReceiptMessage } from '@cardca/schemas';
export { CARDCA_DOMAIN };
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
