import { expect } from "chai";
import { ethers } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const HASH = ethers.id("capabilities-v1");

describe("CertIssuer", function () {
  async function deploy() {
    const signers = await ethers.getSigners();
    const issuers = signers.slice(0, 5);
    const issuerAddresses = await Promise.all(issuers.map((s) => s.getAddress()));
    const factory = await ethers.getContractFactory("CertIssuer");
    const cert = await factory.deploy(issuerAddresses);
    await cert.waitForDeployment();
    return { cert, issuers, outsider: signers[5] };
  }

  async function signAll(issuers: any[], agentId: bigint, certType: number, expiresAt: bigint) {
    const inner = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint8", "bytes32", "uint64"], [agentId, certType, HASH, expiresAt]);
    const digest = ethers.keccak256(inner);
    const sigs = [];
    for (const s of issuers) sigs.push(await s.signMessage(ethers.getBytes(digest)));
    return sigs;
  }

  it("emite atestación con quórum 3-de-5 y queda válida dentro de 24h", async function () {
    const { cert, issuers } = await deploy();
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const expiresAt = now + 3600n;
    const all = await signAll(issuers.slice(0, 3), 1n, 1, expiresAt);
    // El block.timestamp del tx puede avanzar 1s respecto al leído antes del test.
    await expect(cert.issueAttestation(1, 1, HASH, expiresAt, all))
      .to.emit(cert, "AttestationIssued")
      .withArgs(1, 1, HASH, anyValue, expiresAt);
    expect(await cert.isValid(1)).to.equal(true);
  });

  it("revert si la vigencia excede 24 horas", async function () {
    const { cert, issuers } = await deploy();
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const expiresAt = now + 24n * 3600n + 60n;
    const sigs = await signAll(issuers.slice(0, 3), 2n, 1, expiresAt);
    await expect(cert.issueAttestation(2, 1, HASH, expiresAt, sigs)).to.be.revertedWithCustomError(cert, "InvalidExpiry");
  });

  it("revert si vence en el pasado", async function () {
    const { cert, issuers } = await deploy();
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const sigs = await signAll(issuers.slice(0, 3), 3n, 1, now);
    await expect(cert.issueAttestation(3, 1, HASH, now, sigs)).to.be.revertedWithCustomError(cert, "InvalidExpiry");
  });

  it("revert InsufficientQuorum con solo 2 firmas", async function () {
    const { cert, issuers } = await deploy();
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const expiresAt = now + 3600n;
    const sigs = await signAll(issuers.slice(0, 2), 4n, 1, expiresAt);
    await expect(cert.issueAttestation(4, 1, HASH, expiresAt, sigs)).to.be.revertedWithCustomError(cert, "InsufficientQuorum");
  });

  it("revert DuplicateSignature con la misma firma repetida", async function () {
    const { cert, issuers } = await deploy();
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const expiresAt = now + 3600n;
    const sigs = await signAll(issuers.slice(0, 1), 5n, 1, expiresAt);
    await expect(cert.issueAttestation(5, 1, HASH, expiresAt, [sigs[0], sigs[0], sigs[0]])).to.be.revertedWithCustomError(
      cert,
      "DuplicateSignature",
    );
  });

  it("revert con firma de no-emisor", async function () {
    const { cert, issuers, outsider } = await deploy();
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const expiresAt = now + 3600n;
    const sigs = await signAll([issuers[0], issuers[1], outsider], 6n, 1, expiresAt);
    await expect(cert.issueAttestation(6, 1, HASH, expiresAt, sigs)).to.be.revertedWithCustomError(cert, "InvalidIssuerSignature");
  });

  it("anchorRoot: solo emisores pueden anclar", async function () {
    const { cert, issuers, outsider } = await deploy();
    const root = ethers.id("root-1");
    await cert.connect(issuers[0]).anchorRoot(7, root, 4);
    expect(await cert.anchorRoots(7)).to.equal(root);
    expect(await cert.anchorLeafCounts(7)).to.equal(4);
    await expect(cert.connect(outsider).anchorRoot(7, root, 4)).to.be.revertedWithCustomError(cert, "NotAnIssuer");
  });
});
