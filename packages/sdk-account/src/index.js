import { getAddress, isAddress, keccak256, toBeHex, toUtf8Bytes, zeroPadValue } from 'ethers';
import { AGENT_ID_DOMAIN } from '@agentid/schemas';
export { AGENT_ID_DOMAIN };
const DEFAULTS = {
    nonce: '0',
    initCode: '0x',
    callGasLimit: '100000',
    verificationGasLimit: '150000',
    preVerificationGas: '50000',
    maxFeePerGas: '20000000000',
    maxPriorityFeePerGas: '1000000000',
    paymasterAndData: '0x',
    signature: '0x',
};
function toQtyHex(v) {
    return toBeHex(BigInt(v));
}
function assertAddress(v, label) {
    if (typeof v !== 'string' || !isAddress(v)) {
        throw new Error(`${label} must be a valid Ethereum address`);
    }
    return getAddress(v);
}
function canonicalTargetSet(targets) {
    if (!Array.isArray(targets)) {
        throw new Error('allowedTargets must be an array of addresses');
    }
    return new Set(targets.map((t) => assertAddress(t, 'allowedTargets entry')));
}
export function buildUserOperation(req) {
    if (typeof req.callData !== 'string' || !/^0x[0-9a-fA-F]*$/.test(req.callData)) {
        throw new Error('callData must be a hex string');
    }
    return {
        sender: assertAddress(req.sender, 'sender'),
        nonce: toQtyHex(req.nonce ?? DEFAULTS.nonce),
        initCode: req.initCode ?? DEFAULTS.initCode,
        callData: req.callData,
        callGasLimit: toQtyHex(req.callGasLimit ?? DEFAULTS.callGasLimit),
        verificationGasLimit: toQtyHex(req.verificationGasLimit ?? DEFAULTS.verificationGasLimit),
        preVerificationGas: toQtyHex(req.preVerificationGas ?? DEFAULTS.preVerificationGas),
        maxFeePerGas: toQtyHex(req.maxFeePerGas ?? DEFAULTS.maxFeePerGas),
        maxPriorityFeePerGas: toQtyHex(req.maxPriorityFeePerGas ?? DEFAULTS.maxPriorityFeePerGas),
        paymasterAndData: req.paymasterAndData ?? DEFAULTS.paymasterAndData,
        signature: req.signature ?? DEFAULTS.signature,
    };
}
export function userOperationHash(op) {
    const canonical = Object.entries(op)
        .map(([k, v]) => [k, String(v).toLowerCase()])
        .sort(([a], [b]) => a.localeCompare(b));
    return zeroPadValue(keccak256(toUtf8Bytes(JSON.stringify(canonical))), 32);
}
export function estimateOpMaxSpendWei(op) {
    const gas = BigInt(op.callGasLimit) + BigInt(op.preVerificationGas) + BigInt(op.verificationGasLimit);
    return gas * BigInt(op.maxFeePerGas);
}
export function validatePolicy(policy, op, ctx = {}) {
    if (typeof policy.dailyLimitWei !== 'string' || BigInt(policy.dailyLimitWei) < 0n) {
        throw new Error('dailyLimitWei must be a non-negative quantity string');
    }
    const allowed = canonicalTargetSet(policy.allowedTargets);
    const violations = [];
    const spentToday = BigInt(ctx.spentTodayWei ?? '0x0');
    if (spentToday < 0n) {
        throw new Error('spentTodayWei must be non-negative');
    }
    const opSpend = estimateOpMaxSpendWei(op);
    if (spentToday + opSpend > BigInt(policy.dailyLimitWei)) {
        violations.push('DAILY_LIMIT_EXCEEDED');
    }
    if (op.callData.length >= 42) {
        const targetRaw = '0x' + op.callData.slice(op.callData.length - 40);
        try {
            const target = getAddress(targetRaw);
            if (!allowed.has(target)) {
                violations.push('TARGET_NOT_ALLOWED');
            }
        }
        catch {
            violations.push('INVALID_TARGET');
        }
    }
    else if (op.callData !== '0x') {
        violations.push('INVALID_TARGET');
    }
    if (policy.requiresUnderwriter && ctx.hasUnderwriterApproval !== true) {
        violations.push('UNDERWRITER_REQUIRED');
    }
    return { ok: violations.length === 0, violations };
}
