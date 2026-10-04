// EP-19-S3 — Test de agregación en lote: 2 sub-pruebas UltraHonk reales (sub-lotes
// de 4 contrapartes sobre árboles de 1024 hojas, seeds distintos) verificadas en
// UNA transacción por BatchVerifier; una prueba corrupta hace revert/fail.
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIX = join(__dirname, '..', '..', 'zk', 'circuits', 'dc_subbatch', 'fixtures');

function loadSub(i: string) {
  return {
    proof: '0x' + readFileSync(join(FIX, i, 'proof')).toString('hex'),
    pub: Array.from({ length: 36 }, (_, k) =>
      '0x' + readFileSync(join(FIX, i, 'public_inputs')).subarray(k * 32, (k + 1) * 32).toString('hex').padStart(64, '0')),
  };
}

describe('EP-19-S3 — BatchVerifier (agregación de sub-pruebas en una tx)', () => {
  it('verifica 2 sub-pruebas reales en una tx (lote cubierto por sub-lotes)', async () => {
    const relations = await (await ethers.getContractFactory('contracts/HonkVerifierSubbatch.sol:RelationsLib')).deploy();
    const verifier = await ethers.getContractFactory('contracts/HonkVerifierSubbatch.sol:HonkVerifier', {
      libraries: { RelationsLib: await relations.getAddress() },
    });
    const hk = await verifier.deploy();
    await hk.waitForDeployment();

    const bv = await (await ethers.getContractFactory('BatchVerifier')).deploy(await hk.getAddress());
    await bv.waitForDeployment();

    const a = loadSub('pf100');
    const b = loadSub('pf101');
    const tx = await bv.verifyBatch([a.proof, b.proof], [a.pub, b.pub], 8, { gasLimit: 16_000_000 });
    await tx.wait();
    // allOk == true (return value via static call re-check)
    const ok = await bv.verifyBatch.staticCall([a.proof, b.proof], [a.pub, b.pub], 8, { gasLimit: 16_000_000 });
    expect(ok).to.equal(true);
  });

  it('revierte una sub-prueba corrupta dentro del lote', async () => {
    const relations = await (await ethers.getContractFactory('contracts/HonkVerifierSubbatch.sol:RelationsLib')).deploy();
    const verifier = await ethers.getContractFactory('contracts/HonkVerifierSubbatch.sol:HonkVerifier', {
      libraries: { RelationsLib: await relations.getAddress() },
    });
    const hk = await verifier.deploy();
    await hk.waitForDeployment();
    const bv = await (await ethers.getContractFactory('BatchVerifier')).deploy(await hk.getAddress());
    await bv.waitForDeployment();

    const a = loadSub('pf100');
    const bad = '0x' + (a.proof.slice(2, 400) + 'ff' + a.proof.slice(402));
    // el verificador on-chain rechaza: puede devolver false o revertir ante datos malformados
    let rejected = false;
    try {
      const ok = await bv.verifyBatch.staticCall([bad, a.proof], [a.pub, a.pub], 8, { gasLimit: 16_000_000 });
      rejected = !ok;
    } catch {
      rejected = true;
    }
    expect(rejected).to.equal(true);
  });
});
