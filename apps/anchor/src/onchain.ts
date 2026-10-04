import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

export interface DeploymentsFile {
  network: string;
  chainId: number;
  contracts: Record<string, string>;
}

export interface OnchainConfig {
  rpcUrl: string;
  privateKey: string;
  agentId: bigint;
  behaviorProof: string;
  /** Por defecto 84532 (Base Sepolia); e2e local usa 31337 (hardhat). */
  expectedChainId?: bigint;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS_PATH = join(HERE, 'deployments.json');

export const ABI = [
  'function anchorReceipts(uint256 agentId, bytes32 root)',
  'event ReceiptsAnchored(uint256 indexed agentId, bytes32 root, uint64 anchoredAt)',
];

export function loadDeployments(path: string = DEPLOYMENTS_PATH): DeploymentsFile | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as DeploymentsFile;
    return typeof raw?.chainId === 'number' && typeof raw?.contracts === 'object' && raw.contracts !== null
      ? raw
      : null;
  } catch {
    return null;
  }
}

/**
 * Resuelve la configuración para el modo `real`. Devuelve null si falta
 * cualquier prerequisito: la clave del deployer, el deployment de
 * BehaviorProof o el chainId esperado (Base Sepolia, 84532).
 */
export function resolveOnchainConfig(
  env: NodeJS.ProcessEnv,
  deployments: DeploymentsFile | null = loadDeployments(),
  expectedChainId: bigint = 84532n,
): OnchainConfig | null {
  const privateKey = env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) return null;
  const behaviorProof = deployments?.contracts?.BehaviorProof;
  if (!behaviorProof || !ethers.isAddress(behaviorProof)) return null;
  if (deployments.chainId !== Number(expectedChainId)) return null;
  const agentIdRaw = env.AGENTID_AGENT_ID;
  let agentId = 1n;
  if (agentIdRaw !== undefined) {
    try {
      agentId = BigInt(agentIdRaw);
    } catch {
      return null;
    }
    if (agentId < 0n) return null;
  }
  return {
    rpcUrl: env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
    privateKey,
    agentId,
    behaviorProof,
    expectedChainId,
  };
}

export interface OnchainResult {
  txHash: string;
  blockNumber: number | null;
}

/**
 * Ancla `root` on-chain en BehaviorProof.anchorReceipts y espera el recibo.
 */
export interface AnchorContract {
  anchorReceipts: (agentId: bigint, root: string) => Promise<{
    hash: string;
    wait: () => Promise<{ status: number | undefined; blockNumber: number | undefined }>;
  }>;
}

export async function anchorOnChain(
  cfg: OnchainConfig,
  root: string,
  providerFactory: (rpc: string) => ethers.Provider = (rpc) => new ethers.JsonRpcProvider(rpc),
  contractFactory: (cfg: OnchainConfig, wallet: ethers.Wallet) => AnchorContract = (c, wallet) =>
    new ethers.Contract(c.behaviorProof, ABI, wallet) as unknown as AnchorContract,
): Promise<OnchainResult> {
  const provider = providerFactory(cfg.rpcUrl);
  const expected = cfg.expectedChainId ?? 84532n;
  const network = await provider.getNetwork();
  if (network.chainId !== expected) {
    throw new Error(`chainId inesperado ${network.chainId}, se esperaba ${expected}`);
  }
  const wallet = new ethers.Wallet(cfg.privateKey, provider);
  const contract = contractFactory(cfg, wallet);
  const tx = await contract.anchorReceipts(cfg.agentId, root);
  const receipt = await tx.wait();
  if (receipt?.status !== 1) {
    throw new Error('transacción fallida');
  }
  return { txHash: tx.hash, blockNumber: receipt.blockNumber ?? null };
}
