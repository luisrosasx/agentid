export const AGENT_ID_DOMAIN = {
    name: 'AGENT.ID',
    version: '1',
};
export const MAX_ATTESTATION_VALIDITY_SECONDS = 24 * 60 * 60;
export const RECEIPT_STRUCT_NAME = 'BilateralReceipt';
export const ATTESTATION_STRUCT_NAME = 'Attestation';
export const BilateralReceiptStruct = {
    BilateralReceipt: [
        { name: 'agentId', type: 'string' },
        { name: 'counterpartyId', type: 'string' },
        { name: 'counterpartyStakeRoot', type: 'bytes32' },
        { name: 'a2aTaskHash', type: 'bytes32' },
        { name: 'outcome', type: 'uint8' },
        { name: 'digest', type: 'bytes32' },
        { name: 'timestamp', type: 'uint256' },
    ],
};
export const AttestationStruct = {
    Attestation: [
        { name: 'agentId', type: 'string' },
        { name: 'certType', type: 'string' },
        { name: 'capabilitiesHash', type: 'bytes32' },
        { name: 'issuedAt', type: 'uint256' },
        { name: 'expiresAt', type: 'uint256' },
    ],
};
export function getReceiptTypes() {
    return {
        EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
        ],
        ...BilateralReceiptStruct,
    };
}
export function getAttestationTypes() {
    return {
        EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
        ],
        ...AttestationStruct,
    };
}
export class AttestationValidityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AttestationValidityError';
    }
}
export function validateAttestationValidity(att, now = BigInt(Math.floor(Date.now() / 1000))) {
    if (typeof att.issuedAt !== 'bigint' || typeof att.expiresAt !== 'bigint') {
        throw new AttestationValidityError('issuedAt and expiresAt must be bigint seconds');
    }
    if (att.issuedAt < 0n || att.expiresAt < 0n) {
        throw new AttestationValidityError('timestamps must be non-negative');
    }
    if (att.expiresAt <= att.issuedAt) {
        throw new AttestationValidityError('expiresAt must be greater than issuedAt');
    }
    const validity = att.expiresAt - att.issuedAt;
    if (validity > BigInt(MAX_ATTESTATION_VALIDITY_SECONDS)) {
        throw new AttestationValidityError(`attestation validity exceeds maximum of ${MAX_ATTESTATION_VALIDITY_SECONDS} seconds`);
    }
    if (att.expiresAt <= now) {
        throw new AttestationValidityError('attestation has expired');
    }
}
