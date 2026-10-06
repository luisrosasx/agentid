# Alcance de la auditoría — CardCA (spec v1)

> Generado agénticamente (Fase 9.1) · commit base: `3dc1093` (agentid) · 2026-10-04

## Contratos en alcance

| Contrato | Líneas | Rol | Direcciones |
|---|---|---|---|
| `AgentIdRegistry.sol` | 166 | Registro NFT **soulbound** de agentes: mint payable con stake ≥ `MIN_STAKE = 0.01 ETH`, `transferFrom`/`safeTransferFrom` reverts (no transferible), `burnStake`, cuota de flota (`FleetQuotaSet`) | testnet: pendiente de fondeo (workflow `anchor-real.yml` los despliega automáticamente); local test: `0xe7f1…0512` (Hardhat 31337) |
| `CertIssuer.sol` | 108 | Emisión de atestaciones AGENT.CERT firmadas por un **panel de issuers** (`ISSUER_COUNT`, constructor recibe address[]), EIP-712 digest (agentId, certType, capabilitiesHash, expiresAt), vigencia 24 h, anclaje de raíces (`RootAnchored`) | pendiente de fondeo; local: `0x9fE4…fa6e0` |
| `BehaviorProof.sol` | 78 | Proof-of-Behavior: anclaje Merkle de recibos (`ReceiptsAnchored`), disputes (`openDispute`/`resolveDispute`) y **slashing** — solo `slasher` (immutable, quien posee la clave POB) puede imponer `slash` | pendiente; local: `0xCf7E…fB0Fc9` |
| `AgentAccountMinimal.sol` | 92 | Cuenta Agentil **minimal** (NO ERC-4337 completo): owner-payer con límite diario (`setDailyLimit`), allowlist de targets, `_rollDay`, `execute` solo-owner | local: `0x8464…bb63` (deployed en tests) |
| `BatchVerifier.sol` + `HonkVerifier(.sol)`/`HonkVerifierSubbatch.sol` | 41 / 2340 | Verificación de pruebas ZK UltraHonk (generados por `bb write_solidity_verifier` — **no editar a mano**) y agregación en lote de sub-pruebas | local (Fase 8) |

## Superficies de ataque

1. **Quórum de issuers (CertIssuer):** `_digest` + verificación de firma — el auditor debe verificar que la recuperación EIP-712 no permita issuers no registrados ni reuso de digest entre certTypes/vigencias (replay).
2. **Soulbound (Registry):** TODAS las rutas de transferencia deben reverts, incluidas `approve`/interfaces ERC-721 heredadas; el mint payable debe exigir stake ≥0.01 y ligar agentId↔owner sin abuso de reentrancy en refunds.
3. **Slashing (BehaviorProof):** gate único por `slasher` — riesgo de centralización documentado (la clave POB). Verificar que `slash` es determinístico (sin parámetros discrecionales) e idempotente-si-corresponde.
4. **Anclaje (CertIssuer/BehaviorProof):** idempotencia de roots, validación de leafCount, no sobreescritura de un root ya anclado por otro actor.
5. **AgentAccountMinimal:** límite diario con rolado de día (`_rollDay`), allowlist; NO es 4337 — no hay bundler/paymaster/userOp (salvedad EP-23): auditarlo como lo que es, no como wallet 4337.
6. **ZK (Fase 8):** el circuito `distinctCounterparties_v2/dc_subbatch` NO está en alcance de auditoría de contratos, pero su verificador on-chain (HonkVerifier) sí; el commit de pruebas/keys en `zk/` es evidencia, no código confiable.

## Fuera de alcance

- Apps TypeScript (`apps/*`, `packages/*`) — cubiertas por la suite agéntica (200 tests) y CI.
- `zk/circuits/*` (Noir) — auditoría ZK separada (recomendada antes de Fase 10).
- Deployments mainnet (no existen).

## Estado del deploy

Los contratos NO están desplegados en Base Sepolia todavía: el paso está **gated al fondeo** del deployer `0x2255C83Ffec54a198Ef9d1A828A49203a6681528` (0.001 ETH). El workflow `anchor-real.yml` ejecuta deploy → verificación → switch `ANCHOR_MODE=real` automáticamente al aterrizar el fondeo. Las direcciones de testnet se fijarán en `contracts/deployments.json` y en este doc como anexo.
