#!/usr/bin/env bash
# agentid/e2e/verify-anchor.sh — Verificación independiente del anclaje on-chain (Fase 7.6)
#
# Dado ANCHOR_URL y un RPC de Base Sepolia:
#   (a) lee GET /anchors/latest del servicio anchor,
#   (b) recupera el receipt on-chain del txHash (eth_getTransactionReceipt), exige status 0x1
#       y que el root del evento ReceiptsAnchored (decodificado con el ABI de contracts/)
#       coincida con el root reportado por el servicio,
#   (c) pide una Merkle proof de una hoja del lote a /anchors/:batchId/proof/:leafHash
#       y la valida localmente contra el root on-chain (implementación de packages/sdk-receipts),
#   (d) imprime "root on-chain == root local; proof válida para leaf <hash>" y exit 0.
#
# Uso:
#   ANCHOR_URL=http://127.0.0.1:3000 ./agentid/e2e/verify-anchor.sh
#
# Env:
#   ANCHOR_URL        (requerido) URL base del servicio anchor
#   BASE_RPC_URL      (default https://sepolia.base.org)
#   DEPLOYMENTS_JSON  (default <repo>/contracts/deployments.json) — provee addr de BehaviorProof
#   ANCHOR_AGENT_ID   (opcional) filtra el evento por agentId
#
# Verificación local (e2e, red hardhat):
#   cd agentid/contracts && npx hardhat node &           # nodo local :8545
#   DEPLOYER_PRIVATE_KEY=<key-0-de-hardhat> npx hardhat run scripts/deploy.ts --network localhost
#   # anchor en modo real contra el nodo local:
#   DATABASE_URL=... ANCHOR_MODE=real BASE_SEPOLIA_RPC_URL=http://127.0.0.1:8545 \
#     ANCHOR_EXPECTED_CHAIN_ID=31337 DEPLOYER_PRIVATE_KEY=<key> \
#     ANCHOR_DEPLOYMENTS_PATH=<repo>/contracts/deployments.json ANCHOR_BATCHER=off npx tsx src/main.ts
#   # poblar cola (POST /leaves), anclar (POST /batcher/run) y luego:
#   ANCHOR_URL=http://127.0.0.1:3901 BASE_RPC_URL=http://127.0.0.1:8545 ./e2e/verify-anchor.sh
#
# NOTA: no ejecutar contra producción todavía (Fase 7.2 de deploy a testnet está pendiente de funding).
set -euo pipefail

if [[ -z "${ANCHOR_URL:-}" ]]; then
  echo "ERROR: ANCHOR_URL no definido (p. ej. ANCHOR_URL=http://127.0.0.1:3000)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOYMENTS_JSON="${DEPLOYMENTS_JSON:-${REPO_ROOT}/contracts/deployments.json}"
BASE_RPC_URL="${BASE_RPC_URL:-https://sepolia.base.org}"

if [[ ! -f "${DEPLOYMENTS_JSON}" ]]; then
  echo "ERROR: no existe ${DEPLOYMENTS_JSON} (despliega con: cd agentid/contracts && npx hardhat run scripts/deploy.ts --network baseSepolia)" >&2
  exit 1
fi

ABI_JSON="${REPO_ROOT}/contracts/artifacts/contracts/BehaviorProof.sol/BehaviorProof.json"
if [[ ! -f "${ABI_JSON}" ]]; then
  echo "ERROR: no existe el ABI compilado ${ABI_JSON} (ejecuta: cd agentid/contracts && npx hardhat compile)" >&2
  exit 1
fi

TMPDIR_V="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_V}"' EXIT
cat > "${TMPDIR_V}/verify.mjs" <<'NODE_EOF'
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.env.REPO_ROOT;
const require2 = createRequire(join(repoRoot, 'apps/anchor/node_modules/x.js'));
const { ethers } = require2('ethers');
const receipts = require2('@agentid/sdk-receipts');

const anchorUrl = process.env.ANCHOR_URL.replace(/\/+$/, '');
const rpcUrl = process.env.BASE_RPC_URL;
const agentIdFilter = process.env.ANCHOR_AGENT_ID;
const deployments = JSON.parse(readFileSync(process.env.DEPLOYMENTS_JSON, 'utf8'));
const artifact = JSON.parse(readFileSync(process.env.ABI_JSON_PATH, 'utf8'));

function fail(msg) {
  console.error('FALLO: ' + msg);
  process.exit(1);
}

// (a) estado del servicio
let latest;
try {
  const res = await fetch(`${anchorUrl}/anchors/latest`);
  if (!res.ok) fail(`GET /anchors/latest → HTTP ${res.status}: ${await res.text()}`);
  latest = await res.json();
} catch (e) {
  fail(`no se pudo contactar al anchor en ${anchorUrl}: ${e}`);
}
if (!latest.txHash || !/^0x[0-9a-fA-F]{64}$/.test(latest.txHash)) {
  fail(`txHash inválido en /anchors/latest: ${JSON.stringify(latest.txHash)}`);
}
if (!latest.root || !/^0x[0-9a-fA-F]{64}$/.test(latest.root)) {
  fail(`root inválido en /anchors/latest: ${JSON.stringify(latest.root)}`);
}
console.log(`anchor: batch=${latest.batchId} mode=${latest.mode} leaves=${latest.leaves} root=${latest.root} tx=${latest.txHash}`);

// (b) receipt on-chain
const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
const receipt = await provider.getTransactionReceipt(latest.txHash);
if (!receipt) fail(`el tx ${latest.txHash} no existe en ${rpcUrl} (¿reorg o tx inventada?)`);
if (receipt.status !== 1) fail(`el tx ${latest.txHash} NO fue exitoso (status=${receipt.status})`);
console.log(`receipt on-chain ok: block=${receipt.blockNumber} status=0x1`);

const iface = new ethers.Interface(artifact.abi);
const behaviorProofAddr = deployments.contracts?.BehaviorProof;
let anchoredRoot = null;
let eventAgentId = null;
for (const log of receipt.logs) {
  if (behaviorProofAddr && log.address.toLowerCase() !== String(behaviorProofAddr).toLowerCase()) continue;
  try {
    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed && parsed.name === 'ReceiptsAnchored') {
      anchoredRoot = parsed.args.root;
      eventAgentId = parsed.args.agentId?.toString();
      break;
    }
  } catch { /* log de otro evento */ }
}
if (!anchoredRoot) fail(`el tx ${latest.txHash} no emite ReceiptsAnchored${behaviorProofAddr ? ` desde ${behaviorProofAddr}` : ''}`);
if (anchoredRoot.toLowerCase() !== latest.root.toLowerCase()) {
  fail(`root on-chain (${anchoredRoot}) != root del servicio (${latest.root})`);
}
if (agentIdFilter && eventAgentId !== agentIdFilter) {
  fail(`event agentId (${eventAgentId}) != esperado (${agentIdFilter})`);
}
console.log(`root on-chain == root del servicio (${anchoredRoot}) [agentId=${eventAgentId}]`);

// (c) merkle proof de una hoja del lote
let leavesRes = await fetch(`${anchorUrl}/anchors/${latest.batchId}/leaves`);
if (!leavesRes.ok) fail(`GET /anchors/${latest.batchId}/leaves → HTTP ${leavesRes.status}`);
const leavesBody = await leavesRes.json();
const leafHashes = leavesBody.leaves ?? [];
if (leafHashes.length === 0) fail(`el lote ${latest.batchId} no tiene hojas registradas`);
const leaf = leafHashes[0];
const proofRes = await fetch(`${anchorUrl}/anchors/${latest.batchId}/proof/${leaf}`);
if (!proofRes.ok) fail(`GET proof → HTTP ${proofRes.status}: ${await proofRes.text()}`);
const proofBody = await proofRes.json();
if (!Array.isArray(proofBody.proof)) fail(`proof malformada: ${JSON.stringify(proofBody.proof)}`);
const valid = receipts.verifyMerkleProof(leaf, proofBody.proof, anchoredRoot);
if (!valid) fail(`la merkle proof de ${leaf} NO valida contra el root on-chain ${anchoredRoot}`);

// (d)
console.log(`root on-chain == root local; proof válida para leaf ${leaf}`);
console.log('VERIFICACIÓN ON-CHAIN OK');
NODE_EOF

ABI_JSON_PATH="${ABI_JSON}" REPO_ROOT="${REPO_ROOT}" DEPLOYMENTS_JSON="${DEPLOYMENTS_JSON}" BASE_RPC_URL="${BASE_RPC_URL}" ANCHOR_URL="${ANCHOR_URL}" ANCHOR_AGENT_ID="${ANCHOR_AGENT_ID:-}" \
  node "${TMPDIR_V}/verify.mjs"
