export declare const AGENT_ID_DOMAIN: {
    readonly name: "AGENT.ID";
    readonly version: "1";
};
export declare const MAX_ATTESTATION_VALIDITY_SECONDS: number;
export declare const RECEIPT_STRUCT_NAME: "BilateralReceipt";
export declare const ATTESTATION_STRUCT_NAME: "Attestation";
export type Eip712TypeDefinition = {
    name: string;
    type: string;
};
export type Eip712Types = Record<string, Eip712TypeDefinition[]>;
export declare const BilateralReceiptStruct: {
    readonly BilateralReceipt: [{
        readonly name: "agentId";
        readonly type: "string";
    }, {
        readonly name: "counterpartyId";
        readonly type: "string";
    }, {
        readonly name: "counterpartyStakeRoot";
        readonly type: "bytes32";
    }, {
        readonly name: "a2aTaskHash";
        readonly type: "bytes32";
    }, {
        readonly name: "outcome";
        readonly type: "uint8";
    }, {
        readonly name: "digest";
        readonly type: "bytes32";
    }, {
        readonly name: "timestamp";
        readonly type: "uint256";
    }];
};
export declare const AttestationStruct: {
    readonly Attestation: [{
        readonly name: "agentId";
        readonly type: "string";
    }, {
        readonly name: "certType";
        readonly type: "string";
    }, {
        readonly name: "capabilitiesHash";
        readonly type: "bytes32";
    }, {
        readonly name: "issuedAt";
        readonly type: "uint256";
    }, {
        readonly name: "expiresAt";
        readonly type: "uint256";
    }];
};
export interface BilateralReceiptMessage {
    agentId: string;
    counterpartyId: string;
    counterpartyStakeRoot: string;
    a2aTaskHash: string;
    outcome: number;
    digest: string;
    timestamp: bigint;
}
export interface AttestationMessage {
    agentId: string;
    certType: string;
    capabilitiesHash: string;
    issuedAt: bigint;
    expiresAt: bigint;
}
export declare function getReceiptTypes(): Eip712Types;
export declare function getAttestationTypes(): Eip712Types;
export declare class AttestationValidityError extends Error {
    constructor(message: string);
}
export declare function validateAttestationValidity(att: Pick<AttestationMessage, 'issuedAt' | 'expiresAt'>, now?: bigint): void;
