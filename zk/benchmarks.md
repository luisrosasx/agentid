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

## Decisión binaria S2-T2

**El objetivo <5 s/lote de ≤1k recibos NO se cumple con el circuito monolítico**
(el prove de 2^25 gates excede con holgura el presupuesto, además de la huella de
memoria de la compilación del VK, ~7 GB pico). **Se activa el plan B documentado
(EP-19-S3, recursión incremental)**: pruebas por sub-lote (≤128 recibos ≈ 2^19-2^20
gates) agregadas incrementalmente sobre el acumulador de la prueba anterior, con
`strategy: "monolithic" | "incremental"` en el SDK de prueba. El S1-v2 (32 slots,
~2 s) valida que sub-lotes de ese tamaño SÍ cumplen el presupuesto por iteración.

## Nota de entorno (reproducibilidad)

`nargo` no existe como binario win-arm64; el demonio Docker de esta máquina es amd64:

```bash
curl -sL -o noir-x64.tar.gz https://github.com/noir-lang/noir/releases/download/v1.0.0-rc.2/noir-x86_64-unknown-linux-musl.tar.gz
# bb: https://github.com/AztecProtocol/barretenberg/releases/download/v6.0.0-rc.2/barretenberg-amd64-linux.tar.gz
# glibc (Debian), NO Alpine. VM >= 16 GB (C:\Users\LAnge\.wslconfig: [wsl2] memory=16GB)
MSYS_NO_PATHCONV=1 docker run --rm --platform linux/amd64 -v "$PWD:/circ" -w /circ \
  debian:12-slim sh -c "/noir/nargo test"
```

