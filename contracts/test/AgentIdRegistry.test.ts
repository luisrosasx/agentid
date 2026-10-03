import { expect } from "chai";
import { ethers } from "hardhat";

const NAME = "AGENT.ID Registry";
const VERSION = "1";
const KYC_TYPEHASH = ethers.id("KYCAttestation(address owner,uint256 agentId,uint256 expiresAt)");

describe("AgentIdRegistry", function () {
  async function deploy() {
    const [registrar, compliance, operator, fleetOwner, other] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("AgentIdRegistry");
    const registry = await factory.deploy(await registrar.getAddress(), await compliance.getAddress());
    await registry.waitForDeployment();
    return { registry, registrar, compliance, operator, fleetOwner, other };
  }

  async function kycSignature(compliance: any, owner: string, agentId: bigint, expiresAt: bigint, chainId: bigint, verifyingContract: string) {
    const domainSeparator = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          ethers.id("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
          ethers.id(NAME),
          ethers.id(VERSION),
          chainId,
          verifyingContract,
        ],
      ),
    );
    const structHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address", "uint256", "uint256"], [KYC_TYPEHASH, owner, agentId, expiresAt]),
    );
    const digest = ethers.keccak256(ethers.solidityPacked(["string", "bytes32", "bytes32"], ["\x19\x01", domainSeparator, structHash]));
    // El contrato aplica el prefijo personal EIP-191 al recuperar; firmamos el digest EIP-712 tal cual.
    const sig = await compliance.signMessage(ethers.getBytes(digest));
    return sig;
  }

  it("mint feliz: emite identidad y recibe el stake", async function () {
    const { registry, registrar, compliance, operator, fleetOwner } = await deploy();
    await registry.connect(registrar).setFleetQuota(await operator.getAddress(), 10);
    const agentId = 1;
    const expiresAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const sig = await kycSignature(
      compliance,
      await fleetOwner.getAddress(),
      agentId,
      expiresAt,
      (await ethers.provider.getNetwork()).chainId,
      await registry.getAddress(),
    );
    await expect(
      registry.connect(operator).mint(await fleetOwner.getAddress(), agentId, expiresAt, sig, { value: ethers.parseEther("0.01") }),
    )
      .to.emit(registry, "AgentMinted")
      .withArgs(await operator.getAddress(), await fleetOwner.getAddress(), agentId, ethers.parseEther("0.01"));
    expect(await registry.ownerOf(agentId)).to.equal(await fleetOwner.getAddress());
    expect(await registry.fleetCount(await operator.getAddress())).to.equal(1);
  });

  it("revert SOULBOUND: transferFrom prohibido", async function () {
    const { registry, compliance, operator, fleetOwner, other } = await deploy();
    const deployer = (await ethers.getSigners())[0];
    await registry.connect(deployer).setFleetQuota(await operator.getAddress(), 10);
    const agentId = 1;
    const expiresAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const sig = await kycSignature(
      compliance,
      await fleetOwner.getAddress(),
      agentId,
      expiresAt,
      (await ethers.provider.getNetwork()).chainId,
      await registry.getAddress(),
    );
    await registry.connect(operator).mint(await fleetOwner.getAddress(), agentId, expiresAt, sig, { value: ethers.parseEther("0.01") });
    await expect(registry.connect(fleetOwner).transferFrom(await fleetOwner.getAddress(), await other.getAddress(), agentId)).to.be.revertedWithCustomError(
      registry,
      "SOULBOUND",
    );
  });

  it("revert si el stake es insuficiente", async function () {
    const { registry, compliance, operator, fleetOwner } = await deploy();
    const deployer = (await ethers.getSigners())[0];
    await registry.connect(deployer).setFleetQuota(await operator.getAddress(), 10);
    const expiresAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const sig = await kycSignature(
      compliance,
      await fleetOwner.getAddress(),
      1,
      expiresAt,
      (await ethers.provider.getNetwork()).chainId,
      await registry.getAddress(),
    );
    await expect(
      registry.connect(operator).mint(await fleetOwner.getAddress(), 1, expiresAt, sig, { value: ethers.parseEther("0.009") }),
    ).to.be.revertedWithCustomError(registry, "InsufficientStake");
  });

  it("revert QuotaExceeded cuando la flota excede su cuota", async function () {
    const { registry, compliance, operator, fleetOwner } = await deploy();
    const deployer = (await ethers.getSigners())[0];
    await registry.connect(deployer).setFleetQuota(await operator.getAddress(), 1);
    const expiresAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const sig1 = await kycSignature(compliance, await fleetOwner.getAddress(), 1, expiresAt, chainId, await registry.getAddress());
    await registry.connect(operator).mint(await fleetOwner.getAddress(), 1, expiresAt, sig1, { value: ethers.parseEther("0.01") });
    const sig2 = await kycSignature(compliance, await fleetOwner.getAddress(), 2, expiresAt, chainId, await registry.getAddress());
    await expect(
      registry.connect(operator).mint(await fleetOwner.getAddress(), 2, expiresAt, sig2, { value: ethers.parseEther("0.01") }),
    ).to.be.revertedWithCustomError(registry, "QuotaExceeded");
  });

  it("burnStake devuelve el stake al owner del token", async function () {
    const { registry, compliance, operator, fleetOwner } = await deploy();
    const deployer = (await ethers.getSigners())[0];
    await registry.connect(deployer).setFleetQuota(await operator.getAddress(), 10);
    const expiresAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const sig = await kycSignature(
      compliance,
      await fleetOwner.getAddress(),
      1,
      expiresAt,
      (await ethers.provider.getNetwork()).chainId,
      await registry.getAddress(),
    );
    await registry.connect(operator).mint(await fleetOwner.getAddress(), 1, expiresAt, sig, { value: ethers.parseEther("0.05") });
    const before = await ethers.provider.getBalance(await fleetOwner.getAddress());
    await registry.connect(fleetOwner).burnStake(1);
    const after = await ethers.provider.getBalance(await fleetOwner.getAddress());
    expect(after > before).to.be.true;
    await expect(registry.connect(fleetOwner).burnStake(1)).to.be.revertedWithCustomError(registry, "StakeAlreadyBurned");
  });
});
