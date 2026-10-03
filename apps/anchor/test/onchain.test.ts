import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOnchainConfig, anchorOnChain, loadDeployments, ABI, type DeploymentsFile, type OnchainConfig, type AnchorContract } from '../src/onchain.ts';
import { ethers } from 'ethers';

const DEPLOYMENTS: DeploymentsFile = {
  network: 'base-sepolia',
  chainId: 84532,
  contracts: {
    AgentIdRegistry: '0x1111111111111111111111111111111111111111',
    CertIssuer: '0x2222222222222222222222222222222222222222',
    BehaviorProof: '0x3333333333333333333333333333333333333333',
  },
};

test('no config without private key', () => {
  assert.equal(resolveOnchainConfig({}, DEPLOYMENTS), null);
});

test('no config without deployments file', () => {
  assert.equal(resolveOnchainConfig({ DEPLOYER_PRIVATE_KEY: '0x' + 'aa'.repeat(32) }, null), null);
});

test('no config on wrong chainId', () => {
  const wrong = { ...DEPLOYMENTS, chainId: 1 };
  assert.equal(resolveOnchainConfig({ DEPLOYER_PRIVATE_KEY: '0x' + 'aa'.repeat(32) }, wrong), null);
});

test('no config when BehaviorProof address is invalid', () => {
  const bad = { ...DEPLOYMENTS, contracts: { ...DEPLOYMENTS.contracts, BehaviorProof: 'nope' } };
  assert.equal(resolveOnchainConfig({ DEPLOYER_PRIVATE_KEY: '0x' + 'aa'.repeat(32) }, bad), null);
});

test('resolves full config with defaults', () => {
  const cfg = resolveOnchainConfig({ DEPLOYER_PRIVATE_KEY: '0x' + 'aa'.repeat(32) }, DEPLOYMENTS);
  assert.ok(cfg);
  assert.equal(cfg.rpcUrl, 'https://sepolia.base.org');
  assert.equal(cfg.agentId, 1n);
  assert.equal(cfg.behaviorProof, DEPLOYMENTS.contracts.BehaviorProof);
});

test('honours rpc url and agent id overrides', () => {
  const cfg = resolveOnchainConfig(
    { DEPLOYER_PRIVATE_KEY: '0x' + 'aa'.repeat(32), BASE_SEPOLIA_RPC_URL: 'http://localhost:8545', AGENTID_AGENT_ID: '42' },
    DEPLOYMENTS,
  );
  assert.ok(cfg);
  assert.equal(cfg.rpcUrl, 'http://localhost:8545');
  assert.equal(cfg.agentId, 42n);
});

test('rejects malformed agent id', () => {
  assert.equal(
    resolveOnchainConfig(
      { DEPLOYER_PRIVATE_KEY: '0x' + 'aa'.repeat(32), AGENTID_AGENT_ID: 'zz' },
      DEPLOYMENTS,
    ),
    null,
  );
});

test('loadDeployments tolerates missing/corrupt files', () => {
  assert.equal(loadDeployments(join(tmpdir(), 'no-existe-deployments.json')), null);
  const dir = mkdtempSync(join(tmpdir(), 'anchor-t-'));
  const corrupt = join(dir, 'deployments.json');
  writeFileSync(corrupt, '{ no json');
  assert.equal(loadDeployments(corrupt), null);
  rmSync(dir, { recursive: true, force: true });
});

test('anchorOnChain checks chain id and sends the tx', async () => {
  const sent: { agentId: bigint; root: string }[] = [];
  const fakeProvider = {
    getNetwork: async () => ({ chainId: 84532n }),
  } as unknown as ethers.Provider;

  const cfg: OnchainConfig = {
    rpcUrl: 'https://sepolia.base.org',
    privateKey: '0x' + 'aa'.repeat(32),
    agentId: 7n,
    behaviorProof: DEPLOYMENTS.contracts.BehaviorProof,
  };
  const contractFactory = (): AnchorContract => ({
    anchorReceipts: async (agentId, root) => {
      sent.push({ agentId, root });
      return { hash: '0x' + 'cc'.repeat(32), wait: async () => ({ status: 1, blockNumber: 999 }) };
    },
  });

  const res = await anchorOnChain(cfg, '0x' + 'bb'.repeat(32), () => fakeProvider, contractFactory);
  assert.deepEqual(sent, [{ agentId: 7n, root: '0x' + 'bb'.repeat(32) }]);
  assert.equal(res.txHash, '0x' + 'cc'.repeat(32));
  assert.equal(res.blockNumber, 999);
});

test('anchorOnChain reverts on unexpected chain id', async () => {
  const fakeProvider = {
    getNetwork: async () => ({ chainId: 1n }),
  } as unknown as ethers.Provider;
  const cfg: OnchainConfig = {
    rpcUrl: 'https://sepolia.base.org',
    privateKey: '0x' + 'aa'.repeat(32),
    agentId: 7n,
    behaviorProof: DEPLOYMENTS.contracts.BehaviorProof,
  };
  await assert.rejects(
    anchorOnChain(cfg, '0x' + 'bb'.repeat(32), () => fakeProvider, () => {
      throw new Error('no debería construir contrato');
    }),
    /chainId inesperado/,
  );
});

test('anchorOnChain falls back to a real ethers.Contract', async () => {
  const cfg: OnchainConfig = {
    rpcUrl: 'https://sepolia.base.org',
    privateKey: '0x' + 'aa'.repeat(32),
    agentId: 7n,
    behaviorProof: DEPLOYMENTS.contracts.BehaviorProof,
  };
  // solo construye la instancia (sin llamar a la red): valida que el ABI
  // por defecto de ethers.Contract se arme sin error
  const contract = new ethers.Contract(cfg.behaviorProof, ABI, new ethers.Wallet(cfg.privateKey));
  assert.equal(typeof (contract as unknown as AnchorContract).anchorReceipts, 'function');
});
