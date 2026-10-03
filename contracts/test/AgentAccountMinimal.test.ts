import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgentAccountMinimal", function () {
  async function deploy() {
    const [owner, target, otherTarget, recipient] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("AgentAccountMinimal");
    const account = await factory.deploy();
    await account.waitForDeployment();
    await owner.sendTransaction({ to: await account.getAddress(), value: ethers.parseEther("10") });
    return { account, owner, target, otherTarget, recipient };
  }

  it("configura la política y ejecuta un pago permitido", async function () {
    const { account, owner, target, recipient } = await deploy();
    await account.setDailyLimit(ethers.parseEther("1"));
    await account.setTargetAllowed(await target.getAddress(), true);
    await expect(account.execute(await target.getAddress(), ethers.parseEther("0.5")))
      .to.emit(account, "Executed")
      .withArgs(await owner.getAddress(), await target.getAddress(), ethers.parseEther("0.5"), ethers.parseEther("0.5"));
    const balBefore = await ethers.provider.getBalance(await recipient.getAddress());
    // SPEC: execute es solo-owner; un target permitido NO puede ejecutar pagos.
    await expect(account.connect(target).execute(await recipient.getAddress(), ethers.parseEther("0.1"))).to.be.revertedWithCustomError(
      account,
      "NotOwner",
    );
    expect((await ethers.provider.getBalance(await recipient.getAddress())) - balBefore).to.equal(0n);
  });

  it("revert TargetNotAllowed si el destino no está permitido", async function () {
    const { account, target } = await deploy();
    await account.setDailyLimit(ethers.parseEther("1"));
    await expect(account.execute(await target.getAddress(), ethers.parseEther("0.1"))).to.be.revertedWithCustomError(
      account,
      "TargetNotAllowed",
    );
  });

  it("revert DailyLimitExceeded al superar el límite diario", async function () {
    const { account, target } = await deploy();
    await account.setDailyLimit(ethers.parseEther("1"));
    await account.setTargetAllowed(await target.getAddress(), true);
    await account.execute(await target.getAddress(), ethers.parseEther("0.6"));
    await expect(account.execute(await target.getAddress(), ethers.parseEther("0.5"))).to.be.revertedWithCustomError(
      account,
      "DailyLimitExceeded",
    );
  });

  it("el contador diario se reinicia al día siguiente", async function () {
    const { account, target } = await deploy();
    await account.setDailyLimit(ethers.parseEther("1"));
    await account.setTargetAllowed(await target.getAddress(), true);
    await account.execute(await target.getAddress(), ethers.parseEther("1"));
    await expect(account.execute(await target.getAddress(), ethers.parseEther("0.01"))).to.be.revertedWithCustomError(
      account,
      "DailyLimitExceeded",
    );
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);
    await expect(account.execute(await target.getAddress(), ethers.parseEther("0.5"))).to.emit(account, "Executed");
    const [, , spentToday] = await account.policy();
    expect(spentToday).to.equal(ethers.parseEther("0.5"));
  });

  it("solo el owner puede ejecutar y configurar", async function () {
    const { account, target, otherTarget } = await deploy();
    await expect(account.connect(otherTarget).execute(await target.getAddress(), 1n)).to.be.revertedWithCustomError(account, "NotOwner");
    await expect(account.connect(otherTarget).setDailyLimit(1n)).to.be.revertedWithCustomError(account, "NotOwner");
  });
});
