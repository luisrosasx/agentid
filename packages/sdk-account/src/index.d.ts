import { CARDCA_DOMAIN } from '@cardca/schemas';
export { CARDCA_DOMAIN };
export interface UserOperation {
    sender: string;
    nonce: string;
    initCode: string;
    callData: string;
    callGasLimit: string;
    verificationGasLimit: string;
    preVerificationGas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    paymasterAndData: string;
    signature: string;
}
export interface UserOperationRequest {
    sender: string;
    nonce?: string;
    initCode?: string;
    callData: string;
    callGasLimit?: string;
    verificationGasLimit?: string;
    preVerificationGas?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    paymasterAndData?: string;
    signature?: string;
}
export interface SpendPolicy {
    dailyLimitWei: string;
    allowedTargets: string[];
    requiresUnderwriter: boolean;
}
export type PolicyViolation = 'DAILY_LIMIT_EXCEEDED' | 'TARGET_NOT_ALLOWED' | 'UNDERWRITER_REQUIRED' | 'INVALID_TARGET';
export interface PolicyResult {
    ok: boolean;
    violations: PolicyViolation[];
}
export interface PolicyContext {
    spentTodayWei?: string;
    hasUnderwriterApproval?: boolean;
}
export declare function buildUserOperation(req: UserOperationRequest): UserOperation;
export declare function userOperationHash(op: UserOperation): string;
export declare function estimateOpMaxSpendWei(op: UserOperation): bigint;
export declare function validatePolicy(policy: SpendPolicy, op: UserOperation, ctx?: PolicyContext): PolicyResult;
