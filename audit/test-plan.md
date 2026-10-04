# Plan de pruebas — replicación de la suite de AGENT.ID

> Fase 9.1 · para el equipo de auditoría externa

## Requisitos

- Node 22, pnpm 9.15.9, (opcional) Docker para la toolchain ZK.
- Repo: `luisrosasx/agentid` (main). `git clone && pnpm install --frozen-lockfile`.

## Suite de contratos (alcance principal)

```bash
cd contracts
npx hardhat test          # 24 tests: 20 de contratos + 4 ZK (ZkVerifier, BatchVerifier)
```

| Suite | Tests | Qué cubre |
|---|---|---|
| AgentIdRegistry.test.ts | — | soulbound (3 rutas de transferencia), stake mínimo, mint KYC |
| CertIssuer.test.ts | — | digest EIP-712 completo, quórum multi-firma, vigencia 24h |
| BehaviorProof.test.ts | — | anclaje, disputes, slashing solo-slasher |
| AgentAccountMinimal.test.ts | — | límite diario, rolado de día, allowlist |
| ZkVerifier.test.ts | 2 | prueba ZK real UltraHonk verificada on-chain + rechazo de prueba manipulada |
| BatchVerifier.test.ts | 2 | 2 sub-pruebas reales en 1 tx + prueba corrupta rechazada |

## Suite agéntica completa (contexto, no alcance de la auditoría de contratos)

```bash
pnpm -r test              # 200 tests en 17 workspaces (SDKs, apps, e2e helpers)
pnpm -r build             # 16 builds
```

- CI: `.github/workflows/ci.yml` (build + tests + hardhat determinista).
- e2e nocturno: `.github/workflows/e2e-nightly.yml` (e2e-fase4 30 pasos + e2e-auth 10 pasos contra Railway live + suite adversarial ZK).

## Suite adversarial ZK

```bash
node zk/tests/adversarial.mjs --sample=50     # 10.000 casos espejo + 50 ejecuciones reales
# requiere toolchain Noir 1.0.0-rc.2 + bb 6.0.0-rc.2 (ver zk/benchmarks.md, nota de entorno)
```

## Artefactos ZK verificados (evidencia, no código confiable)

- `zk/circuits/distinct_counterparties_v2/proof/` y `zk/circuits/dc_subbatch/fixtures/` — pruebas/VK reales commiteadas.
- El verificador on-chain (`HonkVerifier.sol`) fue **generado** con `bb write_solidity_verifier` — cualquier diferencia entre bytecode compilado y VK debe tratarse como hallazgo.

## Salvedades explícitas (decirle al auditor)

1. `AgentAccountMinimal` NO es ERC-4337 completo (sin bundler/paymaster/userOp) — EP-23 deuda.
2. `slasher` es una clave única (centralización documentada en threat-model §no-resueltas).
3. El anclador de producción (app TS `apps/anchor`) firma y ancla con la clave deployer; la auditoría de contratos no cubre esa app (auditoría de servicios separada si el consorcio la exige).
4. Los contratos no tienen proxy ni freeze; el remedio post-deploy es redeploy completo.
