# CardCA — Referencia de API por servicio

Documentación generada a partir del código real del monorepo (`apps/*/src`). Todos los servicios son Fastify, escuchan en `PORT` (default `3000`) y exponen `GET /healthz` y `GET /metrics`.

## Convenciones transversales

### Autenticación (`AUTH_MODE`)

Todas las apps comparten el esquema de `apps/*/src/auth.ts` (basado en `@cardca/sdk-auth`):

| Modo | Comportamiento |
|---|---|
| `AUTH_MODE=off` (default) | Sin auth; se añade cabecera de debug `X-Auth-Mode: off`. |
| `AUTH_MODE` ≠ `off` | Toda ruta no pública exige cabecera `X-Service-Key`, validada contra `SERVICE_AUTH_KEYS` (lista separada por comas). 401 si falta o no coincide. |

- **Rutas públicas comunes:** `/healthz`, `/metrics`. Cada servicio añade las suyas (ver tabla por servicio).
- **Rate limit:** lecturas GET/HEAD → `RATE_LIMIT_READ_MAX` (default 300/min); mutaciones → `RATE_LIMIT_MUTATION_MAX` (default 30/min). Excepciones por ruta donde aplica.
- **HMAC de servicio:** endpoints sensibles exigen firma HMAC SHA-256 sobre `METHOD\nPATH\nsha256(rawBody)` con cabeceras `x-service-id`, `x-timestamp` (ventana 5 min) y `x-signature`. Secrets configurados en `HMAC_SECRETS` (formato `serviceId:secret,...`). Helper cliente: `computeHmacSignature` de `@cardca/sdk-auth`.

### Dominio EIP-712 (común a issuer/resolver/sdk-verifier)

```jsonc
{
  "name": "CardCA",
  "version": "1",
  "chainId": 31337   // variable CHAIN_ID; 84532 (Base Sepolia) en despliegues reales
}
```

Types `Attestation`: `agentId` (string), `certType` (string), `capabilitiesHash` (bytes32), `challengeId` (string), `issuedAt` (uint64), `expiresAt` (uint64).

---

## apps/issuer — Emisión de Agent Cards

Fuente: `apps/issuer/src/main.ts`.

| Ruta | Método | Auth extra | Descripción |
|---|---|---|---|
| `/healthz` | GET | pública | `{ ok, service: "issuer" }`. |
| `/attestation` | POST | HMAC (`requireHmac`) | Emite una atestación (Agent Card) firmada EIP-712 por la CA. |

**POST /attestation**

Request:

```jsonc
{
  "agentId": "agent:mi-agente",           // requerido, string no vacío
  "certType": "AGENT.CERT",               // requerido
  "capabilitiesHash": "0x…64 hex",        // requerido, bytes32 hex
  "challengeId": "abc123…"                // requerido; debe estar aprobado en challenges
}
```

Validaciones: todos los campos requeridos (400 si falta alguno); `capabilitiesHash` debe casar `/^0x[0-9a-fA-F]{64}$/` (400); el challenge debe estar `passed === true` — se consulta `GET {CHALLENGES_URL}/challenge/{challengeId}` (403 `challenge not passed`). Con `TRUST_CHALLENGES=true` se salta la verificación (solo dev).

Respuesta `201`:

```jsonc
{
  "attestation": { "agentId": "…", "certType": "…", "capabilitiesHash": "…", "challengeId": "…", "issuedAt": 0, "expiresAt": 0 },
  "signature": "0x…",      // firma EIP-712 del issuer
  "issuer": "0x…",         // dirección del signer
  "digest": "0x…"          // TypedDataEncoder.encode(...)
}
```

TTL fijo de la atestación: 24 h (`expiresAt = issuedAt + 86400000`). Persistencia opcional en Postgres (`DATABASE_URL`, tabla `attestations`); la clave primaria es `agentId:challengeId` (idempotente, `ON CONFLICT DO NOTHING`).

Variables: `ISSUER_KEY` (clave privada; si falta, genera una efímera con warning), `CHAIN_ID`, `CHALLENGES_URL`, `TRUST_CHALLENGES`, `DATABASE_URL`, `HMAC_SECRETS`, `PORT`, `LOG_LEVEL`.

---

## apps/resolver — Verificación y resolución

Fuente: `apps/resolver/src/main.ts`.

| Ruta | Método | Auth | Descripción |
|---|---|---|---|
| `/healthz` | GET | pública | `{ ok, service: "resolver" }`. |
| `/resolve/:agentId` | GET | pública (prefijo `/resolve`) | Resuelve la Agent Card vigente de un agente. |
| `/verify` | POST | pública | Verifica una atestación externa (cadena, firma, vigencia). |

**GET /resolve/:agentId**

- `404` `{ valid: false, reason }` — razones posibles: `not found`, `expired`, `issuer mismatch`, `invalid signature`, `malformed attestation`.
- `200`:

```jsonc
{ "valid": true, "attestation": {…}, "signature": "0x…", "issuer": "0x…", "digest": "0x…" }
```

La verificación recorre: campos presentes → no expirada → digest EIP-712 reconstruido con el dominio CardCA → `verifyTypedData` recupera la dirección del issuer y debe coincidir. Cache con TTL 60 s (Redis vía `REDIS_URL`, fallback en memoria).

**POST /verify**

Request: `{ "attestation": {…}, "signature": "0x…", "issuer": "0x…" }` (400 si falta alguno). Si es válida responde `200 { valid: true, attestation, issuer }` y la cachea; si no, `404 { valid: false, reason }`.

Variables: `REDIS_URL` (cache + rate limit), `CHAIN_ID`, `PORT`.

---

## apps/anchor — Anclaje on-chain (Merkle → Base Sepolia)

Fuente: `apps/anchor/src/main.ts`, `batcher.ts`, `onchain.ts`.

| Ruta | Método | Auth | Descripción |
|---|---|---|---|
| `/healthz` | GET | pública | Devuelve además `mode` (`sim`/`real`). |
| `/anchor` | POST | service | Ancla un lote ad-hoc de atestaciones (raíz de Merkle). |
| `/anchors/latest` | GET | service | Último anclaje persistido. |
| `/anchors/:batchId/proof/:leafHash` | GET | service | Merkle proof de una hoja contra el root del lote. |
| `/anchors/:batchId/leaves` | GET | service | Hojas (leaf hashes) de un lote. |
| `/leaves` | POST | service | Encola leaf hashes en la cola de anclaje. |
| `/batcher/run` | POST | service | Fuerza un ciclo del batcher. |

**Modo de operación (fail-closed):** sin `ANCHOR_MODE` la app **no arranca**. `sim` = anclaje simulado (CI/local, txHash determinista); `real` = requiere `DEPLOYER_PRIVATE_KEY` + `ANCHOR_DEPLOYMENTS_PATH` (`contracts/deployments.json`) y escribe en Base Sepolia (`ANCHOR_EXPECTED_CHAIN_ID`, default `84532`).

**POST /anchor** — request `{ "attestations": [ … ] }` (array no vacío, máx 1000 → 413 si excede). Cada atestación se convierte en leaf `keccak256("{i}:{JSON}")`; se calcula la raíz de Merkle. En `real`, sin config on-chain responde `503`; si la tx falla responde `502` **sin txHash falso** (fail-closed). Respuesta `201`:

```jsonc
{ "root": "0x…", "leafCount": 2, "anchoredAt": "ISO", "mode": "sim|real", "txHash": "0x…", "blockNumber": 123|null, "batchId": 7|null }
```

**POST /leaves** — request `{ "agentId": "agent:x", "leafHashes": ["0x…64 hex"] }` (default `agentId: "agent:default"`). Respuesta `201 { queued, ids }`. Requiere `DATABASE_URL`.

**GET /anchors/:batchId/proof/:leafHash** — `400` si `batchId` no es entero positivo o `leafHash` no es bytes32; `404` si el lote no existe o la hoja no pertenece al lote. Respuesta: `{ batchId, leafHash, root, proof, valid }` (`valid` ya verificada con `@cardca/sdk-receipts`).

**POST /batcher/run** — request opcional `{ "batchSize": 100 }` (1..1000, default `ANCHOR_BATCH_SIZE`). Respuesta: resultado del ciclo o `{ ok: true, empty: true }`.

Persistencia: Postgres (`DATABASE_URL`, tablas `anchors` y `pending_leaves`). El batcher automático arranca con el servicio salvo `ANCHOR_BATCHER=off`.

---

## apps/challenges — Retos de comportamiento

Fuente: `apps/challenges/src/main.ts`.

| Ruta | Método | Auth | Descripción |
|---|---|---|---|
| `/healthz` | GET | pública | |
| `/challenge` | POST | service | Emite un reto para un agente. |
| `/challenge/:id` | GET | service | Estado del reto. |
| `/challenge/:id/answer` | POST | service | Responde al reto. |

**POST /challenge** — request `{ "agentId": "agent:x" }` (400 si falta). Respuesta `201`:

```jsonc
{ "id": "hex32", "agentId": "…", "prompt": "sha256 hex", "nonce": "hex32", "expiresAt": epoch_ms }
```

Detalles de implementación: el `prompt` es `sha256("cardca:challenge:{agentId}:{bucket}")` con `bucket = floor(now / 60000)`; el hash esperado es `sha256("{prompt}:{nonce}")`, es decir, **la respuesta correcta es el `nonce` devuelto**. TTL del reto: 300 s.

**GET /challenge/:id** — `404` si no existe. Respuesta: `{ id, agentId, passed, expiresAt, proofHash }`. `passed` es `false` si el reto expiró.

**POST /challenge/:id/answer** — request `{ "answer": "…" }` (400 si falta). `410` si expiró. Si `sha256("{prompt}:{answer}")` no coincide → `403 { passed: false }`. Si coincide → `{ passed: true, proofHash }` con `proofHash = sha256("{id}:{expectedAnswerHash}:{answerHash}")`.

Persistencia: memoria + Postgres opcional (`DATABASE_URL`, tabla `challenges`).

---

## apps/compliance — KYC, retención y borrado (GDPR)

Fuente: `apps/compliance/src/server.ts` y módulos (`attestation.ts`, `erase.ts`, `dpia.ts`).

| Ruta | Método | Auth extra | Descripción |
|---|---|---|---|
| `/healthz` | GET | pública | Devuelve también `store` (`memory`/`postgres`). |
| `/kyc-attestation` | POST | operator EIP-712 + HMAC; rate limit propio `RATE_LIMIT_KYC_MAX` (default 10/min) | Emite atestación KYC firmada. |
| `/retention/:agentId` | GET | service | Reporte de retención del agente. |
| `/dpia/:agentId` | GET | service | Reporte DPIA del agente. |
| `/erase/:agentId` | POST | HMAC | Derecho al olvido: borrado + registro de evidencia. |

**POST /kyc-attestation** — con `AUTH_MODE=off`, el `operatorAddress` viene del body (`{ "operatorAddress": "0x…" }`); con auth activa, `requireOperator` valida firma EIP-712 del operador contra la allowlist `OPERATOR_ADDRESSES` (nonce anti-replay) y **gana siempre la dirección verificada del header `X-Operator-Address`**. Requiere `COMPLIANCE_KEY` configurada (`503` si no). Respuesta `201`: la atestación KYC firmada.

**POST /erase/:agentId** — ejecuta el borrado, genera el registro de erasure (método y timestamp en `attestation.ts`) y lo persiste (tabla `erasure_log` en Postgres, o memoria). Respuesta `200`:

```jsonc
{ "erased": true, "rowsDeleted": {…}, "method": "…", "agentId": "…", "erasedAt": "ISO", "store": "memory|postgres" }
```

---

## apps/credit — Política de crédito

Fuente: `apps/credit/src/server.ts`, `policy.ts`.

| Ruta | Método | Auth | Descripción |
|---|---|---|---|
| `/healthz` | GET | pública | Devuelve también `store`. |
| `/account/:agentId` | GET | service | Score + política calculada. |
| `/account/:agentId/decision` | POST | service | Registra una decisión humana. |

**GET /account/:agentId** — consulta el score al servicio pob-api (`POB_URL`) y aplica la política (`computePolicy`). Respuesta: score con su `source` más la política derivada (incluye `dailyLimitWei`). Sin recibos previos el pob-api responde 404 y se propaga el fallo.

**POST /account/:agentId/decision** — request:

```jsonc
{ "action": "approve" | "reject" | "adjust",   // requerido, 400 si no es uno de los tres
  "dailyLimitWei": "1000000000000000000",      // string, default "0"
  "decidedBy": "operador",                     // default "system"
  "reason": "…" }                              // opcional
```

Respuesta `201 { recorded: true, store, decision }` (la decisión incluye `decidedAt` ISO). Persistencia en `credit_decisions` (Postgres) o memoria.

---

## apps/pob-api — Proof-of-Behavior

Fuente: `apps/pob-api/src/server.ts` y módulos (`receipts.ts`, `cross-attest.ts`, `collusion.ts`, `settlement.ts`, `zk.ts`, `records.ts`).

| Ruta | Método | Auth | Descripción |
|---|---|---|---|
| `/healthz` | GET | pública | Devuelve `store` y `zkRequired`. |
| `/receipt` | POST | service | Registra un recibo bilateral firmado EIP-712. |
| `/score/:agentId` | GET | service | Score del agente a partir de sus recibos. |
| `/credential/:agentId` | POST | service | Credencial de score firmada (24 h). |
| `/cross-attest` | POST | service | Atestación cruzada entre agentes (EP-18). |
| `/zk-attest` | POST | service | Atestación ZK de contrapartes (privacidad, EP-19). |
| `/colusion/:agentId` | GET | service | Análisis anti-colusión (EP-21). |
| `/settle` | POST | service | Split de interchange y settlement (EP-25). |
| `/settlements/:day` | GET | service | Listado read-only de settlements por día. |
| `/slash` | POST | service | Slashing determinístico (EP-28). |
| `/slash/:agentId` | GET | service | Historial de slashes del agente. |

**POST /receipt** — request `{ "receipt": BilateralReceiptMessage, "signature": "0x…" }` (400 si falta firma o el recibo no verifica). El recibo se valida con `verifyReceipt` (`@cardca/sdk-receipts`), se guarda con `signer` y `receivedAt`. Respuesta `201 { accepted: true, signer, store }`.

**GET /score/:agentId** — `404` si el agente no tiene recibos. Si está slasheado devuelve `score: 0, slashed: true`. Si no: `{ ...computeScore(receipts), slashed: false }`.

**POST /credential/:agentId** — firma `{ agentId, score, validUntil }` con `POB_KEY` (efímera si falta, con `ephemeral: true` en la respuesta). Respuesta: `{ agentId, score, validUntil, signature, signer, ephemeral }`.

**POST /cross-attest** — request `{ "agentId": "…" }`. Con `POB_REQUIRE_ZK=true` exige atestación ZK vigente (`409 { error: "zk-required", hint }`). Compara los recibos del agente contra los de todas las contrapartes; registra contradicciones y devuelve `{ agentId, contradictions, verdict }`.

**POST /zk-attest** — request:

```jsonc
{
  "agentId": "…",                  // requerido
  "root": "0x…64 hex",             // root Merkle de identidad
  "minK": 2,                       // entero ≥ 1
  "minWeight": 0,                  // entero ≥ 0 (default 0)
  "counterparties": [              // array no vacío
    { "address": "0x…40 hex", "merklePath": { "siblings": ["0x…64"], "selectors": [true] }, "weak": false, "weight": 100 }
  ]
}
```

Valida la prueba ZK (`verifyZkAttestation`); `400 { error: "zk-attestation invalid", reason }` si falla. Respuesta `201 { accepted: true, attestationHash, root, validAttestations }`.

**POST /settle** — request `{ "gatewayId": "…", "volumeCreditoWei": "1000000", "tier": 3 }` (`tier` entero 1–5, `volumeCreditoWei` string/número entero). Aplica `splitInterchange` y devuelve `{ gatewayId, gatewayBps, agentidBps, gatewayAmountWei, agentidAmountWei, batchRoot }` (root Merkle del día).

**GET /settlements/:day** — `day` en `YYYY-MM-DD` (400 si no). Devuelve `{ day, batchRoot, settlements[] }` — es la fuente que consume `apps/interchange`.

**POST /slash** — request `{ "agentId", "evidenceHash" }`. El hash debe corresponder a una contradicción registrada del mismo agente (`403` si no existe o es de otro agente). Respuesta `201 { slashed: true, agentId, evidenceHash, contradictionType, slashedAt }`.

---

## apps/interchange — Batching y reconciliación de settlements

Fuente: `apps/interchange/src/server.ts` (EP-25 Fase 10A). Puerto default en este servicio: `3010`. Depende de pob-api vía `POB_API_URL` (default `http://127.0.0.1:3000`).

| Ruta | Método | Auth | Descripción |
|---|---|---|---|
| `/healthz` | GET | pública | |
| `/batch/day` | POST | service | Construye el payload del día (settleDay-ready). |
| `/batch/reconcile` | POST | service | Verifica localmente un payload. |

**POST /batch/day** — request `{ "day": "2026-10-06" }` (formato `YYYY-MM-DD` obligatorio, 400 si no). Trae los settlements del día de pob-api y devuelve el `BatchPayload` (`day`, `batchRoot`, `settlements[]`).

**POST /batch/reconcile** — request: un payload con `day` (YYYY-MM-DD), `batchRoot` y `settlements[]` (400 si falta alguno). Ejecuta `reconcile(payload)` y devuelve el `ReconcileResult`.

---

## apps/portal-b2b — Portal para operadores B2B

Fuente: `apps/portal-b2b/src/server.ts`, `operator.ts`, `kpis.ts`.

| Ruta | Método | Auth | Descripción |
|---|---|---|---|
| `/healthz` | GET | pública | |
| `/` | GET | pública (landing con auth on; dashboard con auth off) | HTML. |
| `/api/fleet` | GET | pública | Flota en JSON (`{ identities }`). |
| `/fleet` | GET | pública | Flota en HTML. |
| `/api/kpis` | GET | pública | Dashboard de KPIs en JSON. |
| `/kpis` | GET | pública | Dashboard de KPIs en HTML. |
| `/login` | GET/POST | pública | Login de operador (solo con `AUTH_MODE` ≠ `off`). |

- **Fuente de datos (fail-closed):** default `live` (POB_URL + RESOLVER_URL); sin datos live la flota sale vacía, nunca demo. Datos demo solo con `PORTAL_DEMO_MODE=true` o `PORTAL_DATA_SOURCE=sample`.
- **Sesión de operador (auth on):** `POST /login` acepta Basic auth, form (`user`/`password`) o JSON; éxito → cookie de sesión firmada (HttpOnly, SameSite=Strict, TTL 8 h). Credenciales vía env (`operatorCredentials` en `session.ts`). Rutas públicas: `/`, `/login`, `/healthz`, `/metrics`, más `/api/fleet`, `/fleet`, `/api/kpis`, `/kpis`. Sin sesión, clientes HTML reciben `302 → /login`; el resto `401`.
- **KPIs externos opcionales** vía env: `KPI_CERT_ENFORCING_SERVICES`, `KPI_ATTESTATIONS_PER_DAY`, `KPI_RENEWAL_RATE_PCT`, `KPI_RECEIPT_COVERAGE_PCT`, `KPI_PAYING_FLEETS`, `KPI_ARR_USD`.
- **Manejo de errores:** los 5xx devuelven genérico `{ error: "internal" }` sin stack traces.

---

## Códigos de error comunes

| Código | Cuándo |
|---|---|
| `400` | Payload inválido o campo faltante (mensaje descriptivo en `error`). |
| `401` | `X-Service-Key` ausente/incorrecta con auth activa. |
| `403` | Challenge no aprobado, respuesta de reto incorrecta, o evidencia de slash inválida. |
| `404` | Recurso inexistente o atestación inválida/expirada (resolver). |
| `410` | Challenge expirado. |
| `413` | Lote de anclaje > 1000 atestaciones. |
| `429` | Rate limit excedido. |
| `502` | Fallo de anclaje on-chain en modo `real` (nunca con txHash falso). |
| `503` | Dependencia no configurada (`DATABASE_URL`, `COMPLIANCE_KEY`, config on-chain). |
