// EP-19-S4-T1 — Verificación on-chain (Hardhat local) de una prueba ZK real
// generada con Noir 1.0.0-rc.2 + Barretenberg 6.0.0-rc.2 (UltraHonk, evm-no-zk)
// para el circuito distinct_counterparties_v2 (ver zk/benchmarks.md).
//
// Artefactos commiteados en zk/circuits/distinct_counterparties_v2/proof/:
//   proof (10240 B), public_inputs (36 fields × 32 B), vk (1888 B), vk_hash.
// Verifier.sol generado con `bb write_solidity_verifier -t evm-no-zk`.

import { expect } from 'chai';
import { ethers } from 'hardhat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROOF_DIR = join(__dirname, '..', '..', 'zk', 'circuits', 'distinct_counterparties_v2', 'proof');

function fieldOf(bytes: Buffer): string {
  return '0x' + bytes.toString('hex').padStart(64, '0');
}

describe('EP-19 ZK — HonkVerifier (distinctCounterparties)', () => {
  it('verifica on-chain la prueba real del circuito (5 contrapartes distintas, weightSum>=400)', async () => {
    const relations = await (await ethers.getContractFactory('contracts/HonkVerifier.sol:RelationsLib')).deploy();
    const verifier = await ethers.getContractFactory('contracts/HonkVerifier.sol:HonkVerifier', { libraries: { RelationsLib: await relations.getAddress() } });
    const v = await verifier.deploy();
    await v.waitForDeployment();

    const proof = readFileSync(join(PROOF_DIR, 'proof'));
    const publicInputs = readFileSync(join(PROOF_DIR, 'public_inputs'));
    const NUM_PUBLIC = 36;
    expect(publicInputs.length).to.equal(NUM_PUBLIC * 32);

    const pubArgs: string[] = [];
    for (let i = 0; i < NUM_PUBLIC; i++) {
      pubArgs.push('0x' + publicInputs.subarray(i * 32, (i + 1) * 32).toString('hex').padStart(64, '0'));
    }
    // public inputs esperados: [0..31]=root bytes, 32=min_k=5, 33=min_weight=400, 34=1000, 35=2000
    expect(BigInt(pubArgs[32])).to.equal(5n);
    expect(BigInt(pubArgs[33])).to.equal(400n);
    expect(BigInt(pubArgs[34])).to.equal(1000n);
    expect(BigInt(pubArgs[35])).to.equal(2000n);
    // la raiz va serializada como 32 campos cuyo VALOR es cada byte del root
    const rootBytes = [0xd5,0x19,0x6f,0x01,0x05,0x2a,0xa2,0x32,0xad,0xa1,0x3f,0x42,0xc6,0x4d,0x65,0x7f,0x47,0xa0,0x8f,0x18,0x98,0xc8,0x0f,0x8a,0xa4,0xb0,0x0a,0x10,0x45,0xc0,0xcb,0x12];
    for (let i = 0; i < 32; i++) expect(BigInt(pubArgs[i])).to.equal(BigInt(rootBytes[i]));

    const ok = await v.verify('0x' + proof.toString('hex'), pubArgs);
    expect(ok).to.equal(true);
  });

  it('rechaza una prueba manipulada (flip de un byte del proof)', async () => {
    const relations = await (await ethers.getContractFactory('contracts/HonkVerifier.sol:RelationsLib')).deploy();
    const verifier = await ethers.getContractFactory('contracts/HonkVerifier.sol:HonkVerifier', { libraries: { RelationsLib: await relations.getAddress() } });
    const v = await verifier.deploy();
    await v.waitForDeployment();

    const proof = Buffer.from(readFileSync(join(PROOF_DIR, 'proof')));
    const publicInputs = readFileSync(join(PROOF_DIR, 'public_inputs'));
    proof[100] ^= 0x01;
    const pubArgs: string[] = [];
    for (let i = 0; i < 36; i++) {
      pubArgs.push('0x' + publicInputs.subarray(i * 32, (i + 1) * 32).toString('hex').padStart(64, '0'));
    }
    let ok = false;
    try {
      ok = await v.verify('0x' + proof.toString('hex'), pubArgs);
    } catch {
      ok = false; // el verificador puede revertir ante garbage
    }
    expect(ok).to.equal(false);
  });
});
