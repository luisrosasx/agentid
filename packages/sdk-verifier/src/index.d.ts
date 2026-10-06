import { type AttestationMessage } from '@cardca/schemas';
export declare class AttestationFormatError extends Error {
    constructor(message: string);
}
export interface VerifiedAttestation {
    signer: string;
    attestation: AttestationMessage;
}
export declare function verifyAttestation(att: AttestationMessage, issuerAddress: string, signature: string, now?: bigint): VerifiedAttestation;
