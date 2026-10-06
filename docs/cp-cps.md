# CardCA — Certificate Policy / Certification Practices Statement (borrador)

> **Estado:** BORRADOR v0.1 — documento vivo de trabajo, no aprobado. Este CP/CPS describe las prácticas de emisión de Agent Cards de CardCA. Estructura alineada con RFC 3647; se limita a las secciones relevantes para el modelo actual del monorepo. Documento público bajo `cardca.org` (dominios `crdca.org` solo aparecen incrustados en certificados).

## 1. Introducción

### 1.1. Descripción

CardCA, *"La Autoridad Certificadora de Agent Cards"*, opera una CA pública que emite **Agent Cards**: certificados X.509 (`x5c`) de corta vida que certifican la identidad y capacidades de agentes software, emitidos vía protocolo **ACME**. La identidad se ancla on-chain en Base Sepolia (chainId 84532) y el comportamiento se acredita con Proof-of-Behavior ZK.

### 1.2. Nombres de documentos e identificadores

- Documento: CardCA CP/CPS, borrador v0.1.
- OID de política (pendiente de asignación en la raíz de CardCA).
- Dominios operativos: `acme.cardca.dev` (ACME producción), `acme-staging.cardca.dev` (sandbox), `api.cardca.dev` (API).
- Infraestructura de certificados: CRLs en `https://c.crdca.org`, certificados de emisores (AIA) en `https://i.crdca.org`.

### 1.3. Comunidad de participantes

| Rol | Descripción |
|---|---|
| **CA (CardCA)** | Firma las attestations/certificados. Clave en `ISSUER_KEY` (HSM planificado; wallet EOA actual). |
| **Registrar** | Operador autorizado para mintear identidades en `AgentIdRegistry` con firma KYC del compliance signer. |
| **Compliance signer** | Clave separada que firma attestations KYC EIP-712 (`KYCAttestation(address owner,uint256 agentId,uint256 expiresAt)`). |
| **Sujeto (agente)** | Agente software identificado por un token soulbound en el registry con stake. |
| **Consumidor / gateway** | Verifica cards antes de cursar tareas (p. ej. vía `@cardca/sdk-gateway`). |

### 1.4. Datos personales y cumplimiento

El servicio `compliance` gestiona KYC, DPIA (`GET /dpia/:agentId`), retención (`GET /retention/:agentId`) y derecho al borrado (`/erase/:agentId`). Las claves semánticas de datos (`AGENT_ID_KEYS = ['agent_id','agentId']`) gobiernan el lookup de borrado en los stores.

## 2. Niveles de garantía (provisional)

| Nivel | Nombre | Requisitos de identidad | Vida útil | Anchor on-chain |
|---|---|---|---|---|
| **L0** | Sandbox | Clave de agente sin KYC (solo `acme-staging.cardca.dev`; dominio de prueba `TRUST_CHALLENGES=true`). | 24 h | No |
| **L1** | Básico | Reto de challenges superado + cuenta registrada. | 24 h | Sí (soulbound) |
| **L2** | Identificado | L1 + KYC del operador (firma EIP-712 del compliance signer, caducidad 7 días) + stake ≥ 0.01 ETH. | 24 h | Sí |
| **L3** | Acreditado | L2 + Proof-of-Behavior ZK verificado (`distinct_counterparties`, `min_k` contrapartes, `min_weight` acumulado) sin disputas abiertas ni slashes. | 24 h | Sí |

Notas: la vida útil del certificado es uniforme (24 h, `MAX_ATTESTATION_VALIDITY_SECONDS`); lo que cambia por nivel es la **verificación previa** y el anclaje. `certType` en la attestation refleja el nivel.

## 3. Identificación y autenticación

### 3.1. Registro inicial

1. El operador obtiene una attestation KYC del servicio `compliance` (`POST /kyc-attestation`).
2. El Registrar miente el token soulbound en `AgentIdRegistry` (solo el Registrar puede mintear; `InvalidKYCSignature`/`KYCExpired` si la firma EIP-712 falta o caducó; `QuotaExceeded` si supera la cuota de flota; `InsufficientStake` si el ETH adjunto es < 0.01).
3. El agente demuestra posesión de clave resolviendo un reto: `POST /challenge` → `POST /challenge/:id/answer` en `@cardca/challenges`.

### 3.2. Autenticación en cada emisión

Cada solicitud `POST /attestation` al issuer exige: `agentId`, `certType`, `capabilitiesHash` (bytes32), `challengeId` válido y superado. Con `AUTH_MODE ≠ off`, además HMAC de servicio sobre el rawBody (`HMAC_SECRETS = serviceId:secret,...`, comparación timing-safe) y nonces anti-replay (TTL 10 min).

### 3.3. Verificación previa a la firma (fail-closed)

El issuer consulta el estado del reto en `challenges` antes de firmar. Si el challenge service no responde, el challenge no existe o `passed !== true`, la emisión se rechaza (403). El bypass `TRUST_CHALLENGES=true` está prohibido en producción.

## 4. Ciclo de vida del certificado

| Etapa | Práctica |
|---|---|
| **Emisión** | EIP-712 `Attestation` firmada por la CA sobre dominio `{ name: 'CardCA', version: '1', chainId: 84532 }`; entrega como X.509 `x5c` vía ACME. Registro persistido en `attestations` (PK `agentId:challengeId`, `ON CONFLICT DO NOTHING` — una attestation por reto). |
| **Vida útil** | 24 h exactas (TTL). No hay renovación: nueva emisión con nuevo reto. |
| **Uso** | Presentación del card a gateways; verificación con `@cardca/sdk-verifier` (formato + firma + ventana) y estado on-chain. |
| **Caducidad** | Temporal automática; `expiresAt` obligatorio en la estructura firmada. |
| **Revocación** | CRL en `https://c.crdca.org`; causas: slashing (`BehaviorProof.slash`, `pob-api /slash`), quema de stake (`burnStake`), KYC caducado, borrado GDPR, decisión de compliance. |

## 5. Prácticas de seguridad de la CA

1. **Separación de claves**: clave de la CA (`ISSUER_KEY`) distinta del compliance signer y del deployer on-chain (`DEPLOYER_PRIVATE_KEY`). En dev, clave efímera con warning explícito — prohibida en producción.
2. **Claves on-chain**: el upgrade del sistema es UUPS; los cambios de parámetros del settlement (tesorería, bps) requieren Timelock en dos fases (`schedule*` → `apply*`) — ningún parámetro económico cambia de forma instantánea.
3. **Anclaje**: el anchor (`@cardca/anchor`) valida chainId (84532), deployment (`deployments.json`) y agente antes de escribir; cualquier discrepancia aborta sin escribir.
4. **Seguridad de transporte**: todos los servicios Fastify tras proxy con rate limit y guard de servicio; HMAC de servicio con comparación timing-safe y nonces.
5. **Fail-closed generalizado**: issuer (challenge obligatorio), verificador ZK (prueba requerida para acreditar comportamiento), gateway (deny por defecto según `GatewayEnforcer`).

## 6. Infraestructura de publicación y repositorios

| Recurso | Ubicación | Contenido |
|---|---|---|
| CRLs | `https://c.crdca.org` | Listas de revocación de Agent Cards (CRL DP incrustado en cada certificado). |
| Certs de emisores | `https://i.crdca.org` | Certificados de las CAs intermedias/emisoras (AIA). |
| Transparency log | `cardca.org` | Registro público de certificados emitidos (CT-style; cada attestation emitida es auditable por `batchId` y prueba de inclusión del anchor: `GET /anchors/:batchId/proof/:leafHash`). |
| Estado de anclajes | On-chain Base Sepolia | `BehaviorProof.ReceiptsAnchored(agentId, root, anchoredAt)` y raíces de settlement diarias. |

## 7. Auditoría y disputas

- Las disputas de comportamiento se abren y resuelven on-chain (`BehaviorProof.openDispute`/`resolveDispute`), con slashing cuando se resuelven en contra.
- La detección de colusión entre agentes es previa al acreditar comportamiento (`pob-api/collusion.ts`, `/cross-attest`, `/colusion/:agentId`).
- Auditoría de contratos: documentación en `audit/` (scope, threat model, invariants, reporte Slither, plan de respuesta).
- Revisión de este CP/CPS: trimestral o tras cualquier cambio de claves, niveles de garantía o parámetros del timelock.

## 8. Cambios pendientes (TODO del borrador)

- [ ] Asignar OIDs de política y definir la jerarquía de CA (raíz + intermedia emisora).
- [ ] Confirmar formato exacto del certificado X.509 (profile, extensiones, EKU de Agent Card).
- [ ] Definir parámetros del transparency log (formato de entradas, firma de timestamps, gossip).
- [ ] Política de protección de claves (HSM, rotación, umbrales de emergencia).
- [ ] Cuantificar SLAs de CRL (intervalo de publicación y latencia máxima de revocación).
