# CardCA — Arquitectura

> **CardCA** — *La Autoridad Certificadora de Agent Cards*. Este documento describe la arquitectura real del monorepo `agentid/` (monorepo pnpm). Las referencias de código son verificables: cada componente apunta a su fuente.

## 1. Visión general

CardCA es una **CA pública para Agent Cards**: emite certificados de identidad verificables para agentes software. Un agente demuestra posesión de una clave, supera un reto (challenge) y CardCA le emite un **Agent Card** — una attestation firmada con **EIP-712** sobre el dominio canónico `{ name: 'CardCA', version: '1' }` (ver `packages/schemas/src/index.ts`), presentada en formato **X.509 `x5c`** vía el flujo ACME. La identidad se ancla **on-chain** (Base Sepolia, chainId **84532**; Hardhat local usa 31337) y el comportamiento histórico del agente se acredita con **Proof-of-Behavior** (pruebas ZK Noir, fail-closed). El intercambio entre agentes se liquida en el módulo de **interchange** con settlement Merkle on-chain.

Tres pilares:

1. **Identidad** — registry on-chain (ERC-721 soulbound con stake), attestation firmada por la CA.
2. **Comportamiento** — receipts bilaterales firmados, acumulados en un árbol Merkle anclado on-chain, probados con circuits ZK (Noir).
3. **Intercambio** — settlement diario del interchange con fees por tier de volumen y claims Merkle verificados on-chain.

## 2. Dominios

| Dominio | Rol |
|---|---|
| `cardca.org` | Marca pública: sitio, docs, CP/CPS, transparency log, status. |
| `cardca.dev` | Developers: `acme.cardca.dev` (ACME prod), `acme-staging.cardca.dev` (sandbox), `api.cardca.dev` (API pública). |
| `c.crdca.org` / `i.crdca.org` | Solo URLs incrustadas dentro de certificados: CRLs y certs de emisores. |

## 3. Diagrama

```
                        ┌──────────────────────────────────────────────┐
                        │                 Base Sepolia (84532)         │
                        │                                              │
                        │  AgentIdRegistry   (ERC-721 soulbound+stake) │
                        │  CertIssuer        (attestations on-chain)   │
                        │  BehaviorProof     (anchors + disputes)      │
                        │  InterchangeSettlement (UUPS + Timelock)     │
                        └───────▲───────────▲──────────────────────────┘
                                │ anchor    │ settle / claim
                                │           │
        ┌───────────┐   POST /anchor     ┌───────────────┐
 agente │ challenges│        │           │  interchange   │──► batcher ──► settleDay()
  ─────►│ (retos)   │   ┌────┴────┐      │  (receipts,    │    (Merkle root diario)
        └───────────┘   │ anchor  │      │   batches)     │
             │          │ (batcher)│      └───────▲────────┘
             │ challenge│ └─────────┘              │ /receipt
             │  passed  │        │                 │
             ▼          ▼        │            ┌────┴──────┐
        ┌──────────┐  ┌──────────┐            │  pob-api  │◄── zk proofs (Noir)
        │  issuer  │  │ resolver │            │ (score,   │
        │ (attest. │  │ (verify) │            │  slash)   │
        │  EIP-712)│  └────┬─────┘            └───────────┘
        └────┬─────┘       │                       ▲
             │ x5c/ACME    │ verify                │ consultas
             ▼             ▼                  ┌────┴─────────┐
        ┌───────────────────────────┐          │ portal-b2b   │
        │ gateway-demo / sdk-gateway│          │ (fleet, kpis)│
        │ (enforcer: cache+policy)  │          └──────────────┘
        └───────────────────────────┘          ┌──────────────┐
                                               │  compliance  │
                                               │ (KYC, dpia,  │
                                               │  erase)      │
                                               └──────────────┘
```

## 4. Servicios (`apps/`)

Todos son servicios Fastify (Node ≥22, TypeScript ESM) con `GET /healthz` y `GET /metrics` (Prometheus). Autenticación configurable por `AUTH_MODE` (off por defecto en dev; HMAC de servicio con `HMAC_SECRETS` formato `serviceId:secret,...` vía `@cardca/sdk-auth`), con rate limit (`applyRateLimit`) y guard de servicio (`applyServiceAuth`).

### 4.1 `@cardca/challenges` — retos de verificación

Emite retos que el agente debe superar antes de recibir una attestation.

- `POST /challenge` — crea un reto (persistido en Postgres si hay `DATABASE_URL`).
- `GET /challenge/:id` — consulta estado.
- `POST /challenge/:id/answer` — el agente responde; marca `passed` si es correcto.

El issuer consulta `GET ${CHALLENGES_URL}/challenge/:id` y exige `passed === true` antes de firmar (fail-closed: si no hay `CHALLENGES_URL`, rechaza; solo `TRUST_CHALLENGES=true` lo salta, modo dev).

### 4.2 `@cardca/issuer` — la CA (emisión)

- `POST /attestation` — flujo principal de emisión. Entrada: `agentId`, `certType`, `capabilitiesHash` (bytes32 hex), `challengeId`. Valida el reto contra el servicio de challenges, construye la estructura EIP-712 `Attestation` (`agentId`, `certType`, `capabilitiesHash`, `challengeId`, `issuedAt`, `expiresAt` — TTL de **24 h**, `TTL_MS`), la firma con la wallet de `ISSUER_KEY` sobre el dominio `{ name: 'CardCA', version: '1', chainId }` y persiste la attestation en Postgres (tabla `attestations`, clave `agentId:challengeId`).
- Devuelve `{ attestation, signature, issuer, digest }`. Sin `ISSUER_KEY` usa clave efímera (solo dev, con warning).

Ver `apps/issuer/src/main.ts`.

### 4.3 `@cardca/resolver` — verificación

- `POST /resolve` y `GET /resolve/:agentId` — resuelve el estado/attestation de un agente.
- `POST /verify` — verifica una attestation: formato (`@cardca/sdk-verifier`), firma EIP-712, ventana de validez (máx. 24 h) y estado.

### 4.4 `@cardca/anchor` — anclaje on-chain

Publica raíces Merkle de receipts on-chain.

- `POST /anchor` — ancla un batch.
- `GET /anchors/latest`, `GET /anchors/:batchId/leaves`, `GET /anchors/:batchId/proof/:leafHash` — consulta de anclajes y pruebas de inclusión.
- `GET /leaves`, `POST /batcher/run` — gestión de leaves y ejecución del batcher.

El modo `real` (`apps/anchor/src/onchain.ts`) carga `deployments.json`, exige chainId **84532** (Base Sepolia; local usa 31337), `DEPLOYER_PRIVATE_KEY`, la dirección de `BehaviorProof` y `CARDCA_AGENT_ID` (fallback `AGENTID_AGENT_ID`), y llama `anchorReceipts(agentId, root)`.

### 4.5 `@cardca/compliance` — cumplimiento

- `POST /kyc-attestation` — attestation KYC (firma EIP-712 del compliance signer; alimenta el mint en el registry).
- `GET /dpia/:agentId`, `GET /retention/:agentId` — DPIA y retención de datos.
- `DELETE/POST /erase/:agentId` — derecho al borrado.

### 4.6 `@cardca/credit` — decisión de crédito

- `GET /account/:agentId` — estado de cuenta.
- `GET /account/:agentId/decision` — decisión de política (usado por el gateway vía `CreditClient`).

### 4.7 `@cardca/interchange` — settlement

Registra receipts bilaterales EIP-712 (`BilateralReceipt`: `agentId`, `counterpartyId`, `counterpartyStakeRoot`, `a2aTaskHash`, `outcome`, `digest`, `timestamp`), los agrupa en batches y liquida.

- `GET /` — estado.
- `GET /batch/day`, `POST /batch/reconcile` — batches diarios y reconciliación.

`apps/interchange/src/settlement.ts` define `CARDCA_VOLUME_STEPS` (tiers de volumen) y `splitInterchange(volumeWei, tier)` que deriva el split gateway/agentid en bps; el batcher produce la raíz Merkle diaria que se liquida con `settleDay()` on-chain.

### 4.8 `@cardca/pob-api` — Proof-of-Behavior

- `POST /receipt` — alta de receipt bilateral.
- `GET /score/:agentId` — score de comportamiento.
- `POST /zk-attest`, `POST /cross-attest` — attestations ZK y cross-attestation (anti-colusión).
- `GET /credential/:agentId`, `GET /colusion/:agentId` — credencial y estado de colusión.
- `POST /slash`, `GET /slash/:agentId` — slashing.
- `POST /settle`, `GET /settlements/:day` — settlement diario.

`apps/pob-api/src/zk.ts` implementa el árbol Merkle de receipt roots (10 niveles, `ZK_LEVELS=10` → 1024 leaves, keccak256) que alimenta a los circuits Noir. `collusion.ts` y `cross-attest.ts` detectan manipulación de pares.

### 4.9 `@cardca/portal-b2b` — portal operativo

- `GET /login`, `POST /login` con sesión (`session.ts`).
- `GET /fleet`, `GET /api/fleet` — vista de flota.
- `GET /kpis`, `GET /api/kpis` — KPIs agregados (`kpis.ts`).

### 4.10 `gateway-demo` (sin scope) — gateway de ejemplo

- `POST /enforce` — decisión de enforcement: consulta `ResolverClient` y `CreditClient` (`packages/sdk-gateway`), usa `AttestationCache` y `GatewayEnforcer` (decisión + percentile de latencia). Es el ejemplo de integración para cualquier gateway que quiera exigir un Agent Card válido antes de cursar una tarea A2A.

## 5. Paquetes (`packages/`, scope `@cardca/*`)

| Paquete | Contenido |
|---|---|
| `@cardca/schemas` | Constantes de dominio y structs EIP-712: `CARDCA_DOMAIN` (`{ name: 'CardCA', version: '1' }`, con alias deprecado `AGENT_ID_DOMAIN`), `AttestationStruct`, `BilateralReceiptStruct`, `MAX_ATTESTATION_VALIDITY_SECONDS` (24 h). |
| `@cardca/sdk-auth` | Autenticación de servicios: `InMemoryNonceStore`, `requireHmac` (HMAC sobre rawBody, comparación timing-safe), guard de servicio. |
| `@cardca/sdk-verifier` | Verificación de attestations: `verifyTypedData` de ethers, asserts de formato (agentId, certType, capabilitiesHash bytes32, fechas), ventana de validez. Dominio bit a bit idéntico al issuer. |
| `@cardca/sdk-gateway` | Toolkit de gateway: `AttestationCache` (TTL), `ResolverClient`, `CreditClient`, `GatewayEnforcer` (decisión + métricas), `percentile`. |
| `@cardca/sdk-receipts` | Construcción/serialización de receipts bilaterales para interchange y pob-api. |
| `@cardca/sdk-account` | Helpers de cuenta de agente (stake, estado). |

## 6. Contratos on-chain (`contracts/`)

Hardhat + Solidity ^0.8.24. Redes: Hardhat local (31337, fixture `contracts/deployments.json`) y **Base Sepolia (84532)** vía `scripts/deploy.ts` (workflow `anchor-real`). Direcciones desplegadas viven en `deployments.json`/`contracts/deployments/` y son inmutables.

### 6.1 `AgentIdRegistry.sol`

ERC-721 **soulbound** mínimo para identidades agénticas (`NAME = "CardCA Registry"`). Los tokens no se pueden transferir (`transferFrom`/`approve` revierten con `SOULBOUND`). Características:

- **Mint con stake**: `MIN_STAKE = 0.01 ether`, quemable por el owner del token (`burnStake`).
- **KYC on-chain**: solo un operador autorizado como Registrar puede mintear, con firma EIP-712 del compliance signer sobre `KYCAttestation(address owner,uint256 agentId,uint256 expiresAt)`; `KYC_EXPIRY = 7 days`.
- **Cuota de flota**: `setFleetQuota(operator, cap)` limita agentes por operador.

### 6.2 `CertIssuer.sol`

Attestations de certificado ancladas on-chain: `issueAttestation(agentId, certType, capabilitiesHash, expiresAt, signature)` (digest EIP-712 off-chain verificado), `isValid(agentId)` y `anchorRoot(agentId, root, leafCount)`.

### 6.3 `BehaviorProof.sol`

Anclaje del comportamiento: `anchorReceipts(agentId, root)` (raíz Merkle de receipts), `openDispute`/`resolveDispute` (evidencia y resolución) y `slash(agentId)`.

### 6.4 `InterchangeSettlement.sol` (UUPS + Timelock)

Upgradeable (`Initializable, UUPSUpgradeable, OwnableUpgradeable`). Gestiona la liquidación del interchange:

- `initialize(owner_, treasury_)`.
- **Timelock de parámetros**: `scheduleTreasury`/`applyTreasury` y `scheduleAgentidBps`/`applyAgentidBps` — los cambios de bps y tesorería se programan y se aplican en un paso posterior (dos fases, sin cambios instantáneos).
- `settleDay(day, root, total, …)` — liquida un día con la raíz Merkle del batch.
- `claim(day, Settlement, proof, payee)` — cada agente reclama su parte con prueba de inclusión Merkle (`isClaimed(day, leafHash)` evita doble claim).
- `agentidBpsForVolume(volumeWei)` / `deriveSplit(tier, volumeWei)` — fees por tier de volumen (misma tabla `CARDCA_VOLUME_STEPS` que el off-chain).
- `_authorizeUpgrade` restringido al owner.

## 7. ZK Proof-of-Behavior (`zk/`)

Circuits **Noir** (nargo) en `zk/circuits/`:

- `distinct_counterparties` / `distinct_counterparties_v2` — prueba que el agente interactuó con **al menos `min_k` contrapartes distintas** con peso acumulado `min_weight`, dentro de una ventana temporal (`window_start`/`window_end`), **sin revelar las contrapartes** (solo su membership en el árbol de receipt roots; hashing keccak256 vía `zk/lib/keccak256`).
- `dc_bench` / `dc_subbatch` — variantes para benchmarks y sub-batches de prueba.
- `zk/lib/verifier` y `contracts/contracts/HonkVerifier.sol` (+ `HonkVerifierSubbatch`, `BatchVerifier`) — verificación on-chain de las pruebas UltraPlonk/Honk.
- `zk/tools/` — generación de witnesses (`gen-witness.mjs`, `gen-bench-witness.mjs`, `prove-batch.sh`).
- `zk/adversarial-report.md`, `zk/benchmarks.md`, `zk/tests/` — análisis adversarial y benchmarks.

**Fail-closed**: la policy de pob-api solo acredita comportamiento cuando la prueba ZK verifica (y el verificador on-chain acepta). Si falta el proof, el verificador falla, o el circuito rechaza, el score no mejora — ningún camino degradado acepta evidencia sin prueba. Ídem el issuer (challenge obligatorio) y el anchor (chainId y deployment validados antes de escribir).

## 8. Flujo end-to-end de un Agent Card

1. **Registro** — el operador del agente obtiene attestation KYC del servicio `compliance` (EIP-712 del compliance signer) y miente un token soulbound en `AgentIdRegistry` con stake ≥ 0.01 ETH (respetando la cuota de flota).
2. **Reto** — el agente solicita un reto a `challenges` (`POST /challenge`) y lo responde (`POST /challenge/:id/answer`).
3. **Emisión** — el agente (o su gateway) llama `POST /attestation` en `issuer` con `agentId`, `certType`, `capabilitiesHash` y `challengeId`. El issuer comprueba el reto, firma la `Attestation` EIP-712 (dominio `CardCA`, TTL 24 h) y la persiste. La attestation se presenta como certificado X.509 `x5c` en el flujo ACME (ver `docs/agent-cards.md`).
4. **Verificación** — cualquier consumidor llama `POST /verify` en `resolver` (o usa `@cardca/sdk-verifier`): valida formato, firma EIP-712, ventana de validez y estado on-chain. Los gateways lo hacen vía `@cardca/sdk-gateway` con caché.
5. **Comportamiento** — cada interacción genera un `BilateralReceipt` firmado (interchange / pob-api). Los receipts se acumulan en el árbol Merkle que `anchor` publica en `BehaviorProof.anchorReceipts()`. Los circuits Noir (`distinct_counterparties`) prueban diversidad de contrapartes sin revelarlas, y `HonkVerifier` las verifica on-chain; pob-api combina todo en score, credenciales y slashing.
6. **Settlement** — al cierre del día, el batcher del interchange liquida la raíz diaria con `InterchangeSettlement.settleDay()`; cada agente reclama con `claim(day, settlement, proof, payee)`.

## 9. Despliegue

- Monorepo pnpm (`pnpm-workspace.yaml`: `packages/*`, `apps/*`, `contracts`), Node ≥22.
- Servicios desplegados en Railway (URLs actuales listadas en `BRAND.md` y usadas por `e2e/railway-smoke.sh`; no renombrar en el rebrand).
- Postgres como store compartido (tablas `attestations`, challenges, receipts, settlements…).
- Contratos: `pnpm --filter contracts exec hardhat deploy` → `scripts/deploy.ts`; anclaje real contra Base Sepolia con `DEPLOYER_PRIVATE_KEY` + `deployments.json` de chainId 84532.
- E2E: `bash e2e/e2e-auth.sh`, `bash e2e/verify-anchor.sh`, `bash e2e/railway-smoke.sh`.
