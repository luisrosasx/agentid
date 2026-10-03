import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildUserOperation, validatePolicy, type SpendPolicy, type UserOperation } from '../src/index.js';

const sender = '0x' + '1'.repeat(40);

// encodeCall(selector, target): calldata whose last 20 bytes are the target address.
function encodeCall(target: string): string {
  const sel = '0xa9059cbb';
  return sel + '00'.repeat(32) + target.toLowerCase().replace(/^0x/, '');
}

function makeOp(overrides: Partial<UserOperation> = {}): UserOperation {
  const target = '0x' + 'a'.repeat(40);
  const base = buildUserOperation({
    sender,
    callData: encodeCall(target),
    callGasLimit: '1000',
    maxFeePerGas: '1000000000',
    preVerificationGas: '0',
  });
  return { ...base, ...overrides };
}

const allowedTarget = '0x' + 'a'.repeat(40);

function policy(overrides: Partial<SpendPolicy> = {}): SpendPolicy {
  return {
    dailyLimitWei: '0x8ac7230489e80000', // 10 ETH
    allowedTargets: [allowedTarget],
    requiresUnderwriter: false,
    ...overrides,
  };
}

test('buildUserOperation fills defaults and checksums sender', () => {
  const op = buildUserOperation({ sender, callData: '0x' });
  assert.equal(op.sender.toLowerCase(), sender);
  assert.equal(op.signature, '0x');
  assert.equal(BigInt(op.maxFeePerGas) > 0n, true);
});

test('policy allows an op within daily limit and allowed target', () => {
  const op = makeOp();
  const result = validatePolicy(policy(), op, { spentTodayWei: '0x0' });
  assert.deepEqual(result, { ok: true, violations: [] });
});

test('policy rejects op exceeding daily limit', () => {
  const op = makeOp();
  const tinyLimit = (BigInt(op.callGasLimit) + BigInt(op.preVerificationGas) + BigInt(op.verificationGasLimit)) * BigInt(op.maxFeePerGas) - 1n;
  const result = validatePolicy({ ...policy(), dailyLimitWei: '0x' + tinyLimit.toString(16) }, op, { spentTodayWei: '0x0' });
  assert.deepEqual(result, { ok: false, violations: ['DAILY_LIMIT_EXCEEDED'] });
});

test('policy accumulates spentTodayWei against the limit', () => {
  const op = makeOp();
  const maxSpend = (BigInt(op.callGasLimit) + BigInt(op.verificationGasLimit)) * BigInt(op.maxFeePerGas);
  const result = validatePolicy(policy(), op, { spentTodayWei: '0x' + maxSpend.toString(16) });
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes('DAILY_LIMIT_EXCEEDED'));
});

test('policy rejects a target not in allowedTargets', () => {
  const op = makeOp({ callData: encodeCall('0x' + 'e'.repeat(40)) });
  const result = validatePolicy(policy(), op);
  assert.deepEqual(result, { ok: false, violations: ['TARGET_NOT_ALLOWED'] });
});

test('policy flags INVALID_TARGET for malformed embedded target', () => {
  const op = makeOp({ callData: '0x' + 'zz'.repeat(32) });
  const result = validatePolicy(policy(), op);
  assert.deepEqual(result, { ok: false, violations: ['INVALID_TARGET'] });
});

test('policy requires underwriter approval when configured', () => {
  const op = makeOp();
  const p = policy({ requiresUnderwriter: true });
  const denied = validatePolicy(p, op);
  assert.equal(denied.ok, false);
  assert.ok(denied.violations.includes('UNDERWRITER_REQUIRED'));
  const approved = validatePolicy(p, op, { hasUnderwriterApproval: true });
  assert.deepEqual(approved, { ok: true, violations: [] });
});

test('userOperationHash is stable and field-order independent', () => {
  const op = makeOp();
  const reordered = { signature: op.signature, paymasterAndData: op.paymasterAndData, maxPriorityFeePerGas: op.maxPriorityFeePerGas, maxFeePerGas: op.maxFeePerGas, preVerificationGas: op.preVerificationGas, verificationGasLimit: op.verificationGasLimit, callGasLimit: op.callGasLimit, callData: op.callData, initCode: op.initCode, nonce: op.nonce, sender: op.sender } as UserOperation;
  assert.deepEqual(Object.keys(reordered).reverse(), Object.keys(op));
  assert.notEqual(op, reordered as unknown);
  assert.equal(validatePolicy(policy(), op).ok, validatePolicy(policy(), reordered).ok);
});
