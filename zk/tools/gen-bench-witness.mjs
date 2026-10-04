// EP-19-S2 — Generador de testigo de bench: árbol de 1024 recibos, 64 contrapartes activas
// Uso: node zk/tools/gen-bench-witness.mjs --out <ruta> (desde agentid/)
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const ethers = createRequire(import.meta.url)('../../packages/sdk-receipts/node_modules/ethers');
const { keccak256, getBytes } = ethers;

const LEAVES = 1024, LEVELS = 10, ACTIVE = 64;
const bytes = (b) => getBytes(b);
const keccakLeaf = (a20) => bytes(keccak256(a20));
const keccakNode = (buf) => bytes(keccak256(buf));
const zeroLeaf = keccakLeaf(new Uint8Array(20));

// 64 direcciones deterministas, asignadas a hojas espaciadas en el árbol
const actives = Array.from({ length: ACTIVE }, (_, i) => {
  const a = Buffer.from(new Uint8Array(20));
  a[0] = (i >> 8) & 0xff; a[1] = i & 0xff; a[2] = 0xab;
  return { addr: a, weak: i % 10 === 3, weight: i % 10 === 3 ? 30 : 100 };
});
const activeLeafIdx = Array.from({ length: ACTIVE }, (_, i) => Math.floor(i * (LEAVES / ACTIVE)));
const leafOf = new Map(activeLeafIdx.map((idx, i) => [idx, i]));

const leaves = Array.from({ length: LEAVES }, (_, i) => (leafOf.has(i) ? keccakLeaf(actives[leafOf.get(i)].addr) : zeroLeaf));
let level = leaves, group = 1, height = 0;
const paths = Array.from({ length: LEAVES }, () => ({ siblings: [], selectors: [] }));
while (level.length > 1) {
  const next = [];
  for (let p = 0; p < level.length / 2; p++) {
    const left = level[2 * p], right = level[2 * p + 1];
    const base = 2 * p * group;
    for (let k = 0; k < group; k++) { paths[base + k].siblings.push(right); paths[base + k].selectors.push(false); }
    for (let k = 0; k < group; k++) { paths[base + group + k].siblings.push(left); paths[base + group + k].selectors.push(true); }
    next.push(keccakNode(Buffer.concat([Buffer.from(left), Buffer.from(right)])));
  }
  level = next; group *= 2; height++;
}
if (height !== LEVELS) throw new Error(`altura ${height} != ${LEVELS}`);
const root = level[0];

const toml = (bytes) => `["${Array.from(bytes).map(b => '0x' + b.toString(16).padStart(2, '0')).join('", "')}"]`;
let out = `receipt_root = ${toml(root)}\n`;
out += `min_k = ${ACTIVE}\nmin_weight = ${100 * 9 * 64 + 30 * 6 * 0}\n`; // 64 actives: débil (6 de 64?) → recompute
const sum = actives.reduce((t, a) => t + (a.weak ? a.weight / 10 : a.weight), 0);
out = out.replace(/min_weight = \d+/, `min_weight = ${Math.floor(sum)}`);
out += `window_start = 1000\nwindow_end = 2000\n`;
out += `counterparties = [\n${actives.map(a => `  ${toml(a.addr)}`).join(',\n')}\n]\n`;
out += `weak_flags = [\n${actives.map(a => `  ${a.weak}`).join(',\n')}\n]\n`;
out += `weights = [\n${actives.map(a => `  ${a.weight}`).join(',\n')}\n]\n`;
// paths solo para los 64 activos
out += `siblings = [\n${activeLeafIdx.map(idx => `  [${paths[idx].siblings.map(s => toml(s)).join(', ')}]`).join(',\n')}\n]\n`;
out += `selectors = [\n${activeLeafIdx.map(idx => `  [${paths[idx].selectors.map(s => s.toString())}]`).join(',\n')}\n]\n`;

const outPath = process.argv.find(a => a.startsWith('--out'))?.split('=')[1] ?? 'zk/circuits/dc_bench/Prover.toml';
writeFileSync(outPath, out);
console.log(`bench Prover.toml: leaves=${LEAVES} active=${ACTIVE} weightSum=${Math.floor(sum)} root=0x${Buffer.from(root).toString('hex')} -> ${outPath}`);
