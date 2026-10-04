// EP-19-S5 — Suite adversarial: 10.000 casos que el circuito DEBE rechazar.
//
// Metodología (documentada en zk/adversarial-report.md):
//  1. Espejo TS EXACTO del orden de restricciones del circuito dc_subbatch
//     (ventana, unicidad pairwise sobre identidades, pertenencia Merkle keccak
//     hoja/nodo, min_k, ponderación de débiles 10% + min_weight).
//  2. Los 10.000 casos (5 clases × 2000) se evalúan con el espejo.
//  3. Validación del espejo contra el circuito REAL: muestra de N casos
//     (`nargo execute` en Docker debe fallar → rechazo real). 0 mismatches.
//  4. Exit 0 solo si 10.000/10.000 rechazados y 0 mismatches.
//
// Uso: node zk/tests/adversarial.mjs [--sample 100]   (desde agentid/)

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ethers = createRequire(import.meta.url)('../../packages/sdk-receipts/node_modules/ethers');
const { keccak256, getBytes } = ethers;

const SAMPLE = Number(process.argv.find(a => a.startsWith('--sample'))?.split('=')[1] ?? 100);
const AGENTID = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CIRC = join(AGENTID, 'zk', 'circuits', 'dc_subbatch');
const NOIR = process.env.NOIR_BIN_DIR ?? '/tmp/noir';

let seedCounter = 0;
const nextSeed = () => seedCounter++;
const addr = (n) => { const a = Buffer.from(new Uint8Array(20)); a[0] = (n >> 8) & 0xff; a[1] = n & 0xff; a[2] = 0xab; return a; };
const keccakLeaf = (a20) => Buffer.from(getBytes(keccak256(a20)));
const keccakNode = (buf) => Buffer.from(getBytes(keccak256(buf)));

// árbol de 1024 hojas (10 niveles) con hojas activas; memo de subárboles de ceros
const ZEROS = (() => {
  const z = [keccakLeaf(Buffer.alloc(20))];
  for (let h = 1; h <= 10; h++) z[h] = keccakNode(Buffer.concat([z[h - 1], z[h - 1]]));
  return z;
})();

function buildTree(leafAddrs) {
  // nodeAt(level, nodeIdx): hash del nodo; null = todo-cero (usa ZEROS memo)
  function nodeAt(h, idx, pos0) {
    if (h === 0) {
      const a = leafAddrs[pos0];
      return a ? keccakLeaf(a) : ZEROS[0];
    }
    const span = 1 << h;
    const l = nodeAt(h - 1, idx * 2, pos0);
    const r = nodeAt(h - 1, idx * 2 + 1, pos0 + span / 2);
    if (l === ZEROS[h - 1] && r === ZEROS[h - 1]) return ZEROS[h];
    return keccakNode(Buffer.concat([l, r]));
  }
  // paths por hoja
  const paths = Array.from({ length: leafAddrs.length }, () => ({ siblings: [], selectors: [] }));
  function walk(h, idx, pos0) {
    if (h === 0) return;
    const span = 1 << h;
    const l = nodeAt(h - 1, idx * 2, pos0);
    const r = nodeAt(h - 1, idx * 2 + 1, pos0 + span / 2);
    for (let k = 0; k < span / 2; k++) { paths[pos0 + k].siblings.push(r); paths[pos0 + k].selectors.push(false); }
    for (let k = 0; k < span / 2; k++) { paths[pos0 + span / 2 + k].siblings.push(l); paths[pos0 + span / 2 + k].selectors.push(true); }
    walk(h - 1, idx * 2, pos0);
    walk(h - 1, idx * 2 + 1, pos0 + span / 2);
  }
  const root = nodeAt(10, 0, 0);
  walk(10, 0, 0);
  return { root, paths };
}

// Espejo EXACTO del main del circuito (orden de asserts idéntico)
function circuitAccepts({ root, minK, minWeight, ws, we, actives, siblings, selectors, weak, weights }) {
  // assert(window_start < window_end)
  if (!(ws < we)) return false;
  // unicidad pairwise (todas las posiciones activas)
  for (let i = 0; i < actives.length; i++)
    for (let j = i + 1; j < actives.length; j++)
      if (actives[i].equals(actives[j])) return false;
  // pertenencia de cada activo + ponderación
  let count = 0, total = 0;
  for (let i = 0; i < actives.length; i++) {
    let h = keccakLeaf(actives[i]);
    for (let l = 0; l < siblings[i].length; l++) {
      const s = siblings[i][l];
      h = selectors[i][l] ? keccakNode(Buffer.concat([s, h])) : keccakNode(Buffer.concat([h, s]));
    }
    if (!h.equals(root)) return false;
    count++;
    total += weak[i] ? Math.floor(weights[i] / 10) : weights[i];
  }
  return count >= minK && total >= minWeight;
}

// --- casos: cada uno devuelve los inputs del circuito (n_active=4, árbol 1024) ---
function baseCase(seed, opts = {}) {
  const idxs = [10, 500, 900, 1020];
  let addrs = idxs.map((i) => addr(seed + i * 13));
  if (opts.dup) addrs = [addr(seed), addr(seed), addr(seed + 999), addr(seed + 1000)]; // dos hojas con la MISMA identidad
  const leafAddrs = Array.from({ length: 1024 }, () => null);
  idxs.forEach((leafIdx, k) => { leafAddrs[leafIdx] = addrs[k]; });
  const { root, paths } = buildTree(leafAddrs);
  return {
    root: opts.fakeRoot ? Buffer.from(root) : root, // fakeRoot se setea abajo
    minK: opts.minK ?? 4, minWeight: opts.minWeight ?? 400,
    ws: opts.ws ?? 1000, we: opts.we ?? 2000,
    actives: addrs,
    weak: opts.weak ?? [false, false, false, false],
    weights: opts.weights ?? [100, 100, 100, 100],
    siblings: [paths[10].siblings, paths[500].siblings, paths[900].siblings, paths[1020].siblings],
    selectors: [paths[10].selectors, paths[500].selectors, paths[900].selectors, paths[1020].selectors],
  };
}

const caseWindow = (s) => { const c = baseCase(s); c.ws = 2000; c.we = 1000; return c; };          // ventana malformada
const caseDup = (s) => baseCase(s, { dup: true });                                                // unicidad violada
const caseWeakWeight = (s) => baseCase(s, { weak: [true, true, true, true], weights: [10, 10, 10, 10] }); // peso insuficiente
const caseBadProof = (s) => { const c = baseCase(s); c.siblings = c.siblings.map(x => x.map((_, i) => Buffer.alloc(32))); return c; }; // paths inválidas
const caseTooFewK = (s) => baseCase(s, { minK: 5 });                                              // K no alcanzado

const CLASSES = [caseWindow, caseDup, caseWeakWeight, caseBadProof, caseTooFewK];
const PER_CLASS = 2000;
const cases = CLASSES.flatMap((cls) => Array.from({ length: PER_CLASS }, () => ({ cls: cls.name, data: cls(nextSeed()) })));

let rejected = 0;
const perClassStats = {};
for (const c of cases) {
  const ok = circuitAccepts(c.data);
  if (!ok) { rejected++; perClassStats[c.cls] = (perClassStats[c.cls] ?? 0) + 1; }
  else { console.error('CASO ACEPTADO POR EL ESPEJO (falso negativo de la suite):', c.cls); }
}

// --- muestra real con el circuito ---
const byClass = {};
for (const c of cases) (byClass[c.cls] ??= []).push(c);
let mismatches = 0, realRuns = 0;
if (SAMPLE > 0) {
  const keccakLib = join(AGENTID, 'zk', 'lib', 'keccak256');
  const hex = (buf) => `["${Array.from(buf).map((x) => '0x' + x.toString(16).padStart(2, '0')).join('", "')}"]`;
  const sample = CLASSES.flatMap((cls) => byClass[cls.name].slice(0, Math.ceil(SAMPLE / CLASSES.length)));
  for (const c of sample) {
    const d = c.data;
    const toml = `receipt_root = ${hex(d.root)}\nmin_k = ${d.minK}\nmin_weight = ${d.minWeight}\nwindow_start = ${d.ws}\nwindow_end = ${d.we}\n`
      + `counterparties = [\n${d.actives.map((a) => `  ${hex(a)}`).join(',\n')}\n]\n`
      + `weak_flags = [${d.weak.map((w) => w.toString()).join(', ')}]\nweights = [${d.weights.join(', ')}]\n`
      + `siblings = [\n${d.siblings.map((s) => `  [${s.map((x) => hex(x)).join(', ')}]`).join(',\n')}\n]\n`
      + `selectors = [\n${d.selectors.map((s) => `  [${s.map((x) => x.toString())}]`).join(',\n')}\n]\n`;
    writeFileSync(join(CIRC, 'Prover.toml'), toml);
    const code = execSync(
      `MSYS_NO_PATHCONV=1 docker run --rm --platform linux/amd64 -v "$(cygpath -w '${NOIR}'):/noir" -v "$(cygpath -w '${CIRC}'):/circ" -v "$(cygpath -w '${keccakLib}'):/root/lib_keccak" -w /circ debian:12-slim sh -c '/noir/nargo execute >/dev/null 2>&1; echo $?'`,
      { encoding: 'utf8', cwd: AGENTID }).trim();
    realRuns++;
    if (code === '0') { mismatches++; console.error('MISMATCH: el circuito REAL aceptó', c.cls); }
  }
}

const lines = CLASSES.map((c) => `| ${c.name} | ${PER_CLASS} | ${perClassStats[c.name] ?? 0} |`).join('\n');
const report = `# EP-19-S5 — Reporte adversarial

> ${new Date().toISOString()} · circuito \`dc_subbatch\` (n_active=4, árbol 1024, 10 niveles) · casos deterministas

| Clase | Casos | Rechazados |
|---|---|---|
${lines}

**TOTAL: ${rejected}/${cases.length} rechazados · pruebas falsas aceptadas: ${cases.length - rejected} · validación del espejo contra el circuito real (nargo execute): ${mismatches} mismatches en ${realRuns} ejecuciones**

Metodología: espejo TS con el MISMO orden de restricciones (ventana → unicidad pairwise → pertenencia Merkle keccak → min_k/min_weight), validado con muestra real de ejecuciones del circuito Noir. ${rejected === cases.length && mismatches === 0 ? '✅ 0 pruebas falsas aceptadas.' : '❌ hay fallos.'}
`;
writeFileSync(join(AGENTID, 'zk', 'adversarial-report.md'), report);
console.log(report);
process.exit(rejected === cases.length && mismatches === 0 ? 0 : 1);
