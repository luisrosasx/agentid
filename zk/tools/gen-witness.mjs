// EP-19 — Generador de testigo (Prover.toml) para distinct_counterparties_v2
//
// Construye el árbol Merkle keccak256 coherente con el circuito:
//   hoja = keccak256(addr 20 bytes); nodo = keccak256(izq ++ der); SLOTS hojas
//   (padding = keccak256(0x00…00)). Genera paths + selectors por slot activo.
//
// Uso (desde cardca/): node zk/tools/gen-witness.mjs [--slots 32] [--out <ruta Prover.toml>]

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
// ethers vive en packages/sdk-receipts (ESM resolution no sube al root del monorepo con pnpm)
const ethers = createRequire(import.meta.url)('../../packages/sdk-receipts/node_modules/ethers');
const { keccak256, getBytes } = ethers;

const SLOTS = Number(process.argv.find(a => a.startsWith('--slots'))?.split('=')[1] ?? 32);
const LEVELS = Math.log2(SLOTS);

// 5 contrapartes activas (direcciones demo), la 3ª débil con peso 30
const actives = [
  { addr: '0x1111111111111111111111111111111111111111', weak: false, weight: 100 },
  { addr: '0x2222222222222222222222222222222222222222', weak: false, weight: 100 },
  { addr: '0x3333333333333333333333333333333333333333', weak: true,  weight: 30 },
  { addr: '0x4444444444444444444444444444444444444444', weak: false, weight: 100 },
  { addr: '0x5555555555555555555555555555555555555555', weak: false, weight: 100 },
];
const MIN_K = 5;
const MIN_WEIGHT = 400; // suma ponderada: 100+100+3+100+100 = 403 >= 400

function keccakLeaf(addrBytes20) {
  return getBytes(keccak256(addrBytes20));
}
const keccakNode = (buf) => getBytes(keccak256(buf));

const zeroLeaf = keccakLeaf(new Uint8Array(20));

// hojas: slots 0..4 activos, resto padding
const leaves = Array.from({ length: SLOTS }, (_, i) => (i < actives.length ? keccakLeaf(getBytes(actives[i].addr)) : zeroLeaf));

// árbol: paths por HOJA (índice de hoja), subiendo nivel a nivel
let level = leaves;
let group = 1; // hojas por nodo en el nivel actual
const paths = Array.from({ length: SLOTS }, () => ({ siblings: [], selectors: [] }));
let height = 0;
while (level.length > 1) {
  const next = [];
  for (let p = 0; p < level.length / 2; p++) {
    const left = level[2 * p];
    const right = level[2 * p + 1];
    // las hojas cubiertas por el nodo izquierdo: [p*2*group, p*2*group+group)
    const base = 2 * p * group;
    for (let k = 0; k < group; k++) {
      paths[base + k].siblings.push(right); // hermano (derecho) del nodo izquierdo
      paths[base + k].selectors.push(false);
    }
    for (let k = 0; k < group; k++) {
      paths[base + group + k].siblings.push(left); // hermano (izquierdo) del nodo derecho
      paths[base + group + k].selectors.push(true);
    }
    next.push(keccakNode(Buffer.concat([Buffer.from(left), Buffer.from(right)])));
  }
  level = next;
  group *= 2;
  height++;
}
if (height !== LEVELS) throw new Error(`altura ${height} != LEVELS ${LEVELS}`);
const root = level[0];

const toml = (bytes) => `["${Array.from(bytes).map(b => '0x' + b.toString(16).padStart(2, '0')).join('", "')}"]`;

let out = `receipt_root = ${toml(root)}\n`;
out += `min_k = ${MIN_K}\nmin_weight = ${MIN_WEIGHT}\n`;
out += `window_start = 1000\nwindow_end = 2000\n`;
out += `counterparties = [\n${Array.from({ length: SLOTS }, (_, i) =>
  `  ${toml(i < actives.length ? getBytes(actives[i].addr) : new Uint8Array(20))}`).join(',\n')}\n]\n`;
out += `used_flags = [\n${Array.from({ length: SLOTS }, (_, i) =>
  `  ${i < actives.length}`).join(',\n')}\n]\n`;
out += `weak_flags = [\n${Array.from({ length: SLOTS }, (_, i) =>
  `  ${i < actives.length && actives[i].weak}`).join(',\n')}\n]\n`;
out += `weights = [\n${Array.from({ length: SLOTS }, (_, i) =>
  `  ${i < actives.length ? actives[i].weight : 0}`).join(',\n')}\n]\n`;
out += `siblings = [\n${Array.from({ length: SLOTS }, (_, i) =>
  `  [${paths[i].siblings.map(s => toml(s)).join(', ')}]`).join(',\n')}\n]\n`;
out += `selectors = [\n${Array.from({ length: SLOTS }, (_, i) =>
  `  [${paths[i].selectors.map(s => s.toString())}]`).join(',\n')}\n]\n`;

const outPath = process.argv.find(a => a.startsWith('--out'))?.split('=')[1] ??
  'zk/circuits/distinct_counterparties_v2/Prover.toml';
writeFileSync(outPath, out);
console.log(`Prover.toml: slots=${SLOTS} root=0x${Buffer.from(root).toString('hex')} actives=${actives.length} weightSum=403 -> ${outPath}`);
