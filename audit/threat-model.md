# Modelo de amenazas — AGENT.ID (contratos v1)

> Fase 9.1 · generado agénticamente a partir de la suite real (24 tests Hardhat) y los hallazgos internos verificados (analysis/fase-a/A4-DEUDA-TECNICA.md)

## Activos a proteger

1. **Identidad (NFT soulbound)** — la inmutabilidad del vínculo agente↔owner es la raíz de confianza; su roto = todo el stack inválido.
2. **Stake (0.01 ETH/mint)** — 经济 skin-in-the-game de operadores; su robo o burn ilegítimo = pérdida directa de fondos.
3. **Atestaciones (AGENT.CERT)** — firma de issuers; su falsificación = pasaporte falso de capacidades.
4. **Score/Recibos (PoB)** — anclaje Merkle + disputes; su manipulación = reputación falsa → crédito falso (Cuenta Agentil financia 0.42 ETH/día sobre él).
5. **Slashing** — penalización determinística; su abuso = censura de agentes legítimos.

## Actores y confianza

| Actor | Poder | Límite |
|---|---|---|
| Panel de issuers (`ISSUER_COUNT` addresses, multisig-off-chain) | Firmar atestaciones | No pueden mintar ni slash |
| `slasher` (clave POB, immutable en BehaviorProof) | `slash(agentId)` | Determinístico, sin parámetros discrecionales |
| `registrar` (Registry) | Mint con stake | Solo por KYC firmado por `complianceSigner` |
| Owner de AgentAccountMinimal | execute bajo límite diario + allowlist | No supera dailyLimit ni targets no permitidos |
| Usuario externo | lecturas; disputes open (BehaviorProof) | No altera estado protegido |

## Superficies y controles testeados

- **Replay de digest EIP-712** (agentId, certType, capabilitiesHash, expiresAt): testeados los 4 campos en el digest (test suite CertIssuer); vigencia 24 h testada.
- **Soulbound**: `transferFrom`/`safeTransferFrom` reverts en 3 rutas (tests).
- **Stake**: `InsufficientStake` bajo 0.01 ETH (test).
- **Anclaje**: root+leafCount con evento (tests); **idempotencia/autorización del anclador**: solo quien firma puede `anchorRoot` — el anclador de producción usa la clave deployer (punto único documentado).
- **Slashing**: solo `slasher` (test); determinístico.
- **Quórum 3-de-5**: implementado en CertIssuer (tests de emisión multi-firma).

## Amenazas no resueltas (declaradas al auditor)

1. `slasher` centralizado: la clave POB comprometida permite slashing masivo → mitigación propuesta: mover `slasher` a un contrato de dispute con quórum (deuda EP-18 DisputeCourt, F9).
2. Registrar/issuers off-chain: quién es `registrar` y el panel — gobernanza del consorcio (Fase 9.4) debe definir key rotation.
3. `AgentAccountMinimal` NO es 4337: sin mempool, sin paymaster, sin bundler — la cuenta "agentil" real (EP-08/23) es deuda; el contrato actual audita como wallet simple con policy.
4. Anclador comprometido: la DEPLOYER_PRIVATE_KEY de Railway puede anclar roots falsos; la verificación independiente (`verify-anchor.sh`) reduce la confianza requerida pero no la elimina.
5. Contratos sin proxy y sin freeze: cualquier fix post-deploy requiere redeploy completo + re-punto de servicios (barato en testnet, costoso en mainnet).
