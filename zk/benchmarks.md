# EP-19 — Benchmarks ZK (MVP v1)

> **Fecha:** 2026-10-04 · Toolchain: Noir 1.0.0-rc.2 (nargo, binario linux x86_64 musl vía
> Docker) + Barretenberg 6.0.0-rc.2 (bb, ultra_honk, target evm-no-zk). Circuito:
> `zk/circuits/distinct_counterparties`.

## MVP v1 — medición real

Flujo completo ejecutado en un contenedor amd64 (`debian:12-slim`), host Windows ARM64:

| Paso | Comando | Tiempo medido |
|---|---|---|
| Compile (ACIR) | `nargo compile` | <1 s |
| Witness | `nargo execute` | <1 s |
| Prove (UltraHonk) | `bb prove --write_vk -t evm-no-zk` | ~1.5 s |
| Verify (host) | `bb verify` | ~0.1 s |
| **Total prove+verify** | | **~2 s** (prove 6.7 KB de prueba, 32 contrapartes) |

- `nargo test`: **4/4 ok** (distinct, duplicado rechazado, K insuficiente rechazado,
  duplicados inactivos aceptados).
- `bb verify`: **"Proof verified successfully"** — prueba real verificada con
  `min_k=5` y 5 contrapartes ocultas (privadas).
- Prueba + VK + public_inputs commiteados como evidencia en `proof/`.

## Pendiente para el objetivo <5 s/lote (EP-19-S2)

- El bench objetivo es por lote de ≤1k recibos con árbol Merkle (S1-T1/T3: pertenencia
  + ponderación de débiles ≤10%) — el MVP mide el circuito base de unicidad con n=32.
- Testigo de 1k recibos añadirá ~1k hojas × Merkle path (log₂(1k)=10 niveles) —
  estimación por el tamaño actual: sigue dentro del presupuesto con margen, pero la
  medición real del S2-T2 es la que decide (gate binario).
- Fallback S3 (recursión incremental) solo si el bench real lo excede.

## Nota de entorno

`nargo` no existe como binario win-arm64; la ejecución agéntica correcta es:

```bash
curl -sL -o noir-x64.tar.gz https://github.com/noir-lang/noir/releases/download/v1.0.0-rc.2/noir-x86_64-unknown-linux-musl.tar.gz
MSYS_NO_PATHCONV=1 docker run --rm --platform linux/amd64 -v "$PWD:/circ" -w /circ \
  debian:12-slim sh -c "/noir/nargo test"
```
