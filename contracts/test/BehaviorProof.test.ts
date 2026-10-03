import { expect } from "chai";
import { ethers } from "hardhat";

describe("BehaviorProof", function () {
  async function deploy() {
    const [slasher, challenger, agent] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("BehaviorProof");
    const pob = await factory.deploy(await slasher.getAddress());
    await pob.waitForDeployment();
    return { pob, slasher, challenger, agent };
  }

  it("anchorReceipts ancla el root y queda consultable", async function () {
    const { pob, agent } = await deploy();
    const root = ethers.id("behavior-root");
    const tx = await pob.anchorReceipts(1n, root);
    const rc = await tx.wait();
    const ev = rc!.logs.map((l) => pob.interface.parseLog(l)).find((p) => p!.name === "ReceiptsAnchored");
    expect(ev!.args.root).to.equal(root);
    const receipt = await pob.receipts(1n);
    expect(receipt.root).to.equal(root);
    expect(receipt.anchoredAt).to.not.equal(0);
    void agent;
  });

  it("disputes: abrir y resolver por el slasher", async function () {
    const { pob, slasher, challenger } = await deploy();
    await pob.anchorReceipts(2n, ethers.id("root-2"));
    await pob.connect(challenger).openDispute(2n, ethers.id("evidence"));
    await expect(pob.connect(slasher).resolveDispute(2n, 0n, true)).to.emit(pob, "DisputeResolved").withArgs(2n, 0n, true);
    await expect(pob.connect(slasher).resolveDispute(2n, 0n, true)).to.be.revertedWithCustomError(pob, "DisputeAlreadyResolved");
    await expect(pob.connect(challenger).resolveDispute(2n, 0n, true)).to.be.revertedWithCustomError(pob, "NotSlasher");
  });

  it("slash: solo SLASHER, una vez por agente", async function () {
    const { pob, slasher, challenger } = await deploy();
    await expect(pob.connect(challenger).slash(3n)).to.be.revertedWithCustomError(pob, "NotSlasher");
    await expect(pob.connect(slasher).slash(3n)).to.emit(pob, "Slashed");
    await expect(pob.connect(slasher).slash(3n)).to.be.revertedWithCustomError(pob, "AlreadySlashed");
    expect(await pob.slashed(3n)).to.equal(true);
    expect(await pob.totalSlashed()).to.equal(1);
  });
});
