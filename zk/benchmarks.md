# EP-19 — Benchmarks ZK (MVP v1 + S2 real)

> **Fecha:** 2026-10-04 · Toolchain: Noir 1.0.0-rc.2 (nargo, binario linux x86_64 musl vía
> Docker) + Barretenberg 6.0.0-rc.2 (bb, ultra_honk, target evm-no-zk). Circuito:
> `zk/circuits/distinct_counterparties_v2` (S1) y `zk/circuits/dc_bench` (S2).

## S1 — MVP v1 (circuito base, 32 slots, 5 niveles)

Flujo completo ejecutado en un contenedor amd64 (`debian:12-slim`), host Windows ARM64:

| Paso | Comando | Tiempo medido |
|---|---|---|
| Compile (ACIR) | `nargo compile` | <1 s |
| Witness | `nargo execute` | <1 s |
| Prove (UltraHonk) | `bb prove --write_vk -t evm-no-zk` | ~1.5 s |
| Verify (host) | `bb verify` | ~0.1 s |
| **Total prove+verify** | | **~2 s** (prove 6.7 KB de prueba, 32 contrapartes) |

- `nargo test`: **5/5 ok** (pertenencia ok/errónea, selector invertido, duplicados, ventana, unicidad).
- `bb verify`: **"Proof verified successfully"** — prueba real verificada con
  `min_k=5` y 5 contrapartes ocultas (privadas).
- Prueba + VK + public_inputs commiteados como evidencia en `proof/`.
- Verificación ON-CHAIN adicional: `HonkVerifier.sol` (bb, evm-no-zk) desplegado en
  red Hardhat local — `verify()` **true** con la prueba real, **false/revert** con un
  byte alterado (`contracts/test/ZkVerifier.test.ts`, 2 passing).

## S2 — Bench real: lote ≤1k recibos (árbol de 1024 hojas, 64 contrapartes × 10 niveles)

Circuito `dc_bench` (mismo pipeline, sin slots de padding: solo los 64 activos con paths):

| Métrica | Valor medido |
|---|---|
| ACIR opcodes | 290,702 |
| Circuit size (gates) | **23,450,994 (~2^25)** |
| `bb gates` (desglose) | 3 m 20 s |
| Witness (`nargo execute`, 1024 hojas keccak) | **3.8 s** |
| Prove (`bb prove --write_vk`) | >10 min en VM de 16 GB (2^25 gates — see nota) |
| Verify (`bb verify`) | ~0.1 s |

## S3 — Estrategia incremental por sub-lotes (medición real)

Circuito `dc_subbatch` (sub-lote de **4 contrapartes activas** × 10 niveles sobre
árbol de 1024 hojas; mismo pipeline):

| Métrica | Valor medido |
|---|---|
| Circuit size | **1,458,939 gates (~2^21)** |
| Setup una vez (compile + witness + `bb write_vk`) | 22–36 s |
| Prove por sub-prueba (VK cacheado, VM tibia) | **10–16 s** (var: 10,5 / 25,5 / 30,6 / 11 / 12 / 16 s) |
| Verify por sub-prueba | **0,13–0,25 s** |
| Agregación on-chain (`BatchVerifier.verifyBatch`, red Hardhat local) | 2 sub-pruebas en **1 tx** (861 ms con deploy incluido; solo-verificación ~300-500 ms) |
| **Lote de 256 recibos end-to-end** (`prove-batch.sh --size 4 --count 64`) | **64/64 sub-pruebas verificadas**, ~12 s c/u ≈ **13 min total** en este entorno |

**Decisión del tamaño de sub-lote:** 4 activos (16 s/prove medio en este entorno). El
entorno ejecuta amd64 EMULADO sobre host ARM64 (Docker Desktop/WSL2), lo que infla los
tiempos ~5-10×; en hardware amd64 nativo el mismo circuito estaría en 2-4 s. La estrategia
incremental es la única viable: el monolítico (23,45M gates) excede por completo.

Agregación práctica (S3-T1 implementado como plan B): sub-pruebas independientes con la
MISMA VK (circuito fijo) → `BatchVerifier.verifyBatch(proofs[], publicInputs[][])` las
verifica todas en una transacción (loop sobre `HonkVerifier.verify`); cada sub-lote lleva
su propia sub-raíz (árbol de 1024 hojas, 4 contrapartes por sub-lote, seeds deterministas).
La recursión in-circuito real (ClientIVC) queda como evolución documentada.

## Nota de entorno (reproducibilidad)

`nargo` no existe como binario win-arm64; el demonio Docker de esta máquina es amd64:

```bash
curl -sL -o noir-x64.tar.gz https://github.com/noir-lang/noir/releases/download/v1.0.0-rc.2/noir-x86_64-unknown-linux-musl.tar.gz
# bb: https://github.com/AztecProtocol/barretenberg/releases/download/v6.0.0-rc.2/barretenberg-amd64-linux.tar.gz
# glibc (Debian), NO Alpine. VM >= 16 GB (C:\Users\LAnge\.wslconfig: [wsl2] memory=16GB)
MSYS_NO_PATHCONV=1 docker run --rm --platform linux/amd64 -v "$PWD:/circ" -w /circ \
  debian:12-slim sh -c "/noir/nargo test"
```

