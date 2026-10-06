import { network, ethers } from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";

/**
 * Deploy CardCA contracts to a real network (e.g. base-sepolia).
 *
 * Requiere:
 *  - DEPLOYER_PRIVATE_KEY en el entorno (cuenta con fondos en la red destino)
 *  - BASE_SEPOLIA_RPC_URL (opcional, default https://sepolia.base.org)
 *
 * Uso:
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network baseSepolia
 *
 * Escribe las direcciones en:
 *  - contracts/deployments/<network>.json
 *  - apps/anchor/src/deployments.json (modo de anclaje real del anchor)
 */
async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No hay signer: define DEPLOYER_PRIVATE_KEY en el entorno (cuenta con fondos) antes de desplegar",
    );
  }
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer: ${deployer.address} (balance ${ethers.formatEther(balance)} ETH)`);
  if (balance === 0n) {
    throw new Error("La cuenta deployer no tiene fondos; no se despliega");
  }

  // Para un deploy de testnet el deployer actúa como registrar/compliance/slasher
  // y como el set de 5 issuers de CertIssuer (el issuerSet no se reconfigura por ahora).
  const issuerAddrs = Array.from({ length: 5 }, () => deployer.address) as [string, string, string, string, string];

  const registry = await (await ethers.getContractFactory("AgentIdRegistry")).deploy(
    deployer.address,
    deployer.address,
  );
  await registry.waitForDeployment();

  const certIssuer = await (await ethers.getContractFactory("CertIssuer")).deploy(issuerAddrs);
  await certIssuer.waitForDeployment();

  const behaviorProof = await (await ethers.getContractFactory("BehaviorProof")).deploy(deployer.address);
  await behaviorProof.waitForDeployment();

  const record = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      AgentIdRegistry: await registry.getAddress(),
      CertIssuer: await certIssuer.getAddress(),
      BehaviorProof: await behaviorProof.getAddress(),
    },
  };
  console.log(JSON.stringify(record, null, 2));

  mkdirSync("deployments", { recursive: true });
  writeFileSync(`deployments/${network}.json`, JSON.stringify(record, null, 2) + "\n");
  // deployments.json canónico para herramientas de verificación (e2e/verify-anchor.sh
  // lo usa por defecto) y para el anchor en modo real
  writeFileSync("deployments.json", JSON.stringify(record, null, 2) + "\n");
  writeFileSync(
    "../apps/anchor/src/deployments.json",
    JSON.stringify({ network: network.name, chainId: record.chainId, contracts: record.contracts }, null, 2) + "\n",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
