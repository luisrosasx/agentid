import { expect } from "chai";
import { ethers } from "hardhat";

// ── Réplica TS del leaf/árbol de apps/pob-api/src/settlement.ts ──────────────
// Leaf: keccak256(toUtf8Bytes(JSON.stringify([gatewayId, day, volumeWei,
// gatewayAmountWei, agentidAmountWei]))). La igualdad con el leaf Solidity se
// prueba directamente contra `settlementLeaf` del contrato (test "leaf match").
const T = 10n ** 18n;

function leafOf(rec: { gatewayId: string; day: string; volumeWei: string; gatewayAmountWei: string; agentidAmountWei: string }): string {
  return ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify([rec.gatewayId, rec.day, rec.volumeWei, rec.gatewayAmountWei, rec.agentidAmountWei]),
    ),
  );
}

// Pares ordenados (estándar OZ) + duplicación del nodo impar.
function merkleProof(leaves: string[], index: number): string[] {
  let level = [...leaves].sort();
  let idx = level.indexOf(leaves[index]);
  const proof: string[] = [];
  while (level.length > 1) {
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push(level[sib] ?? level[idx]);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      next.push(ethers.keccak256(ethers.concat([lo, hi])));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return ethers.keccak256(ethers.toUtf8Bytes("empty"));
  let level = [...leaves].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      next.push(ethers.keccak256(ethers.concat([lo, hi])));
    }
    level = next;
  }
  return level[0];
}

const GATEWAY_BPS_BY_TIER = [60, 50, 40, 32, 25];
function agentidBpsForVolume(volumeWei: bigint): number {
  if (volumeWei <= 100_000n * T) return 90;
  if (volumeWei <= 1_000_000n * T) return 80;
  if (volumeWei <= 10_000_000n * T) return 70;
  if (volumeWei <= 100_000_000n * T) return 60;
  return 50;
}

function splitInterchange(volumeWei: bigint, tier: number) {
  const gatewayBps = GATEWAY_BPS_BY_TIER[tier - 1];
  const agentidBps = agentidBpsForVolume(volumeWei);
  return {
    gatewayBps,
    agentidBps,
    gatewayAmountWei: ((volumeWei * BigInt(gatewayBps)) / 10_000n).toString(),
    agentidAmountWei: ((volumeWei * BigInt(agentidBps)) / 10_000n).toString(),
  };
}

interface Rec {
  gatewayId: string;
  tier: number;
  volumeWei: string;
  gatewayBps: number;
  agentidBps: number;
  gatewayAmountWei: string;
  agentidAmountWei: string;
  day: string;
}

function makeRec(gatewayId: string, tier: number, volumeWei: bigint, day: string): Rec {
  const s = splitInterchange(volumeWei, tier);
  return {
    gatewayId,
    tier,
    volumeWei: volumeWei.toString(),
    gatewayBps: s.gatewayBps,
    agentidBps: s.agentidBps,
    gatewayAmountWei: s.gatewayAmountWei,
    agentidAmountWei: s.agentidAmountWei,
    day,
  };
}

const DAY = "2026-01-15";
const DAY_UINT = 20260115n;

describe("InterchangeSettlement", function () {
  async function deploy() {
    const [owner, operator, treasury, gateway] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("InterchangeSettlement");
    const impl = await factory.deploy();
    await impl.waitForDeployment();
    const init = impl.interface.encodeFunctionData("initialize", [await owner.getAddress(), await treasury.getAddress()]);
    const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await proxyFactory.deploy(await impl.getAddress(), init);
    await proxy.waitForDeployment();
    const cs = await ethers.getContractAt("InterchangeSettlement", await proxy.getAddress());
    return { cs, impl, owner, operator, treasury, gateway };
  }

  function settlementStruct(rec: Rec) {
    return {
      gatewayId: rec.gatewayId,
      day: rec.day,
      tier: rec.tier,
      volumeWei: BigInt(rec.volumeWei),
      gatewayBps: rec.gatewayBps,
      agentidBps: rec.agentidBps,
      gatewayAmountWei: BigInt(rec.gatewayAmountWei),
      agentidAmountWei: BigInt(rec.agentidAmountWei),
    };
  }

  async function settle(cs: any, recs: Rec[], day: string = DAY, dayUint: bigint = DAY_UINT) {
    const leaves = recs.map((r) => leafOf(r));
    const root = merkleRoot(leaves);
    const total = recs.reduce((acc, r) => acc + BigInt(r.volumeWei), 0n);
    const gateways = new Set(recs.map((r) => r.gatewayId)).size;
    await cs.settleDay(dayUint, root, total, gateways);
    return { leaves, root };
  }

  it("deploy + inicialización: owner, treasury, bps por defecto e initializer deshabilitado", async function () {
    const { cs, impl, owner, treasury } = await deploy();
    expect(await cs.owner()).to.equal(await owner.getAddress());
    expect(await cs.treasury()).to.equal(await treasury.getAddress());
    expect(await cs.minAgentidBps()).to.equal(50n);
    expect(await cs.maxAgentidBps()).to.equal(90n);
    expect(await cs.CONFIG_DELAY()).to.equal(48n * 3600n);
    // re-inicializar el proxy revierte (initializer); el impl también está blindado
    await expect(cs.initialize(await owner.getAddress(), await treasury.getAddress())).to.be.revertedWithCustomError(
      cs,
      "InvalidInitialization",
    );
    await expect(impl.initialize(await owner.getAddress(), await treasury.getAddress())).to.be.revertedWithCustomError(
      impl,
      "InvalidInitialization",
    );
    // ERC1967 implementation slot apunta al impl
    const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const stored = await ethers.provider.getStorage(await cs.getAddress(), slot);
    expect("0x" + stored.slice(-40).toLowerCase()).to.equal((await impl.getAddress()).toLowerCase());
  });

  it("leaf match: el leaf Solidity coincide con JSON.stringify de pob-api", async function () {
    const { cs } = await deploy();
    const rec = makeRec("gw-1", 2, 500_000n * T, DAY);
    const s = settlementStruct(rec);
    expect(await cs.settlementLeaf(s)).to.equal(leafOf(rec));
  });

  it("settleDay guarda el día; solo owner u operator", async function () {
    const { cs, owner, operator } = await deploy();
    const root = ethers.id("root");
    await expect(cs.connect(operator).settleDay(DAY_UINT, root, 1000n, 2)).to.be.revertedWithCustomError(cs, "NotOperator");
    await cs.setOperator(await operator.getAddress(), true);
    await expect(cs.connect(operator).settleDay(DAY_UINT, root, 1000n, 2))
      .to.emit(cs, "DaySettled")
      .withArgs(DAY_UINT, root, 1000n, 2);
    const ds = await cs.getDaySettlement(DAY_UINT);
    expect(ds.batchRoot).to.equal(root);
    expect(ds.totalVolumeWei).to.equal(1000n);
    expect(ds.gatewayCount).to.equal(2n);
    expect(ds.settledAt).to.be.gt(0n);
    // día repetido revierte; otro owner sí puede
    await expect(cs.settleDay(DAY_UINT, root, 1000n, 2)).to.be.revertedWithCustomError(cs, "DayAlreadySettled", );
  });

  it("claim happy path con proof válida de 3 settlements", async function () {
    const { cs, treasury } = await deploy();
    const recs = [makeRec("gw-1", 1, 50_000n * T, DAY), makeRec("gw-2", 3, 2_000_000n * T, DAY), makeRec("gw-3", 5, 500_000_000n * T, DAY)];
    const { leaves } = await settle(cs, recs);
    const idx = 0;
    const proof = merkleProof(leaves, idx);
    const rec = recs[idx];
    const leafHash = ethers.keccak256(leafOf(rec));
    const payee = ethers.Wallet.createRandom().address;
    await expect(cs.claim(DAY_UINT, settlementStruct(rec), proof, payee))
      .to.emit(cs, "SettlementClaimed")
      .withArgs(DAY_UINT, leafHash, "gw-1", payee, BigInt(rec.gatewayAmountWei), BigInt(rec.agentidAmountWei));
    expect(await cs.isClaimed(DAY_UINT, leafHash)).to.equal(true);
    expect(await cs.agentidCredit(DAY_UINT)).to.equal(BigInt(rec.agentidAmountWei));
    expect(await cs.treasury()).to.equal(await treasury.getAddress());
  });

  it("claim duplicado revierte AlreadyClaimed", async function () {
    const { cs } = await deploy();
    const recs = [makeRec("gw-1", 2, 10_000n * T, DAY)];
    const { leaves } = await settle(cs, recs);
    const s = settlementStruct(recs[0]);
    const proof = merkleProof(leaves, 0);
    await cs.claim(DAY_UINT, s, proof, ethers.Wallet.createRandom().address);
    await expect(cs.claim(DAY_UINT, s, proof, ethers.Wallet.createRandom().address)).to.be.revertedWithCustomError(
      cs,
      "AlreadyClaimed",
    );
  });

  it("prueba inválida revierte InvalidProof; día no fijado revierte DayNotSettled", async function () {
    const { cs } = await deploy();
    const recs = [makeRec("gw-1", 1, 10_000n * T, DAY), makeRec("gw-2", 1, 20_000n * T, DAY)];
    const { leaves } = await settle(cs, recs);
    const other = makeRec("gw-9", 1, 30_000n * T, DAY);
    await expect(cs.claim(DAY_UINT, settlementStruct(other), merkleProof(leaves, 0), ethers.ZeroAddress)).to.be.revertedWithCustomError(
      cs,
      "InvalidProof",
    );
    // proof del índice equivocado
    await expect(cs.claim(DAY_UINT, settlementStruct(recs[0]), merkleProof(leaves, 1), ethers.ZeroAddress)).to.be.revertedWithCustomError(
      cs,
      "InvalidProof",
    );
    // día sin settle
    const solo = makeRec("gw-1", 1, 10_000n * T, "2026-02-01");
    await expect(
      cs.claim(20260201n, settlementStruct(solo), [], ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(cs, "DayNotSettled");
  });

  it("montos manipulados revierte AmountMismatch", async function () {
    const { cs } = await deploy();
    const recs = [makeRec("gw-1", 1, 50_000n * T, DAY)];
    const { leaves } = await settle(cs, recs);
    const proof = merkleProof(leaves, 0);
    const bad = settlementStruct(recs[0]);
    bad.gatewayAmountWei += 1n;
    await expect(cs.claim(DAY_UINT, bad, proof, ethers.ZeroAddress)).to.be.revertedWithCustomError(cs, "AmountMismatch");
    const badAgentid = settlementStruct(recs[0]);
    badAgentid.agentidAmountWei += 1n;
    await expect(cs.claim(DAY_UINT, badAgentid, proof, ethers.ZeroAddress)).to.be.revertedWithCustomError(cs, "AmountMismatch");
    const badBps = settlementStruct(recs[0]);
    badBps.agentidBps = 89; // bps inconsistentes ⇒ montos re-derivados difieren
    await expect(cs.claim(DAY_UINT, badBps, proof, ethers.ZeroAddress)).to.be.revertedWithCustomError(cs, "AmountMismatch");
    const badTier = settlementStruct(recs[0]);
    badTier.tier = 4; // bps de gateway inconsistentes con el tier declarado
    await expect(cs.claim(DAY_UINT, badTier, proof, ethers.ZeroAddress)).to.be.revertedWithCustomError(cs, "AmountMismatch");
  });

  it("invariante del split on-chain: 100 volúmenes aleatorios × 5 tiers + bordes de los umbrales", async function () {
    const { cs } = await deploy();
    const thresholds = [100_000n * T, 1_000_000n * T, 10_000_000n * T, 100_000_000n * T, 1_000_000_000n * T];
    const cases: bigint[] = [];
    for (const t of thresholds) cases.push(t, t - 1n, t + 1n);
    let seed = 123456789n;
    const rand = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return seed >> 16n;
    };
    for (let i = 0; i < 100; i++) cases.push(rand() % (500_000_000n * T));
    for (const volume of cases) {
      for (let tier = 1; tier <= 5; tier++) {
        const [gwBps, agBps, gwAmt, agAmt] = await cs.deriveSplit.staticCall(tier, volume);
        const expected = splitInterchange(volume, tier);
        expect(gwBps).to.equal(expected.gatewayBps);
        expect(agBps).to.equal(expected.agentidBps);
        expect(gwAmt).to.equal(BigInt(expected.gatewayAmountWei));
        expect(agAmt).to.equal(BigInt(expected.agentidAmountWei));
        expect(gwBps).to.be.gte(25n).and.lte(60n);
        expect(agBps).to.be.gte(50n).and.lte(90n);
        expect(gwAmt + agAmt).to.be.lte(volume);
      }
    }
    expect(cases.length).to.equal(15 + 100);
  });

  it("deriveSplit revierte con tier inválido", async function () {
    const { cs } = await deploy();
    await expect(cs.deriveSplit.staticCall(0, T)).to.be.revertedWithCustomError(cs, "InvalidTier");
    await expect(cs.deriveSplit.staticCall(6, T)).to.be.revertedWithCustomError(cs, "InvalidTier");
  });

  it("two-step con delay 48h para setTreasury", async function () {
    const { cs, owner } = await deploy();
    const newTreasury = ethers.Wallet.createRandom().address;
    await expect(cs.applyTreasury()).to.be.revertedWithCustomError(cs, "NoPendingChange");
    await cs.scheduleTreasury(newTreasury);
    await expect(cs.scheduleTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(cs, "InvalidTreasury");
    // antes del delay revierte
    await expect(cs.applyTreasury()).to.be.revertedWithCustomError(cs, "ChangeNotExecutable");
    expect(await cs.treasury()).to.not.equal(newTreasury);
    // solo owner agenda
    await expect(cs.connect(ethers.Wallet.createRandom().connect(ethers.provider)).scheduleTreasury(newTreasury)).to.be.reverted;
    await ethers.provider.send("evm_increaseTime", [48 * 3600 - 10]);
    await expect(cs.applyTreasury()).to.be.revertedWithCustomError(cs, "ChangeNotExecutable");
    await ethers.provider.send("evm_increaseTime", [20]);
    await expect(cs.applyTreasury()).to.emit(cs, "TreasuryChanged").withArgs(newTreasury);
    expect(await cs.treasury()).to.equal(newTreasury);
    // consumido: sin pending nuevo revierte
    await expect(cs.applyTreasury()).to.be.revertedWithCustomError(cs, "NoPendingChange");
  });

  it("two-step con delay 48h para agentidBps", async function () {
    const { cs } = await deploy();
    await expect(cs.scheduleAgentidBps(10, 90)).to.be.revertedWithCustomError(cs, "InvalidBpsRange");
    await expect(cs.scheduleAgentidBps(50, 95)).to.be.revertedWithCustomError(cs, "InvalidBpsRange");
    await expect(cs.scheduleAgentidBps(80, 70)).to.be.revertedWithCustomError(cs, "InvalidBpsRange");
    await cs.scheduleAgentidBps(55, 85);
    await expect(cs.applyAgentidBps()).to.be.revertedWithCustomError(cs, "ChangeNotExecutable");
    await ethers.provider.send("evm_increaseTime", [48 * 3600 + 5]);
    await expect(cs.applyAgentidBps()).to.emit(cs, "AgentidBpsChanged").withArgs(55, 85);
    expect(await cs.minAgentidBps()).to.equal(55n);
    expect(await cs.maxAgentidBps()).to.equal(85n);
    // el rango configuran el check del split
    await expect(cs.deriveSplit.staticCall(1, 10n)).to.be.revertedWithCustomError(cs, "AgentidBpsOutOfRange");
  });

  it("upgrade UUPS solo owner", async function () {
    const { cs, impl, owner } = await deploy();
    const other = ethers.Wallet.createRandom().connect(ethers.provider);
    await expect(cs.connect(other).upgradeToAndCall(await impl.getAddress(), "0x")).to.be.reverted;
    await expect(cs.connect(owner).upgradeToAndCall(await impl.getAddress(), "0x")).to.not.be.reverted;
  });
});
