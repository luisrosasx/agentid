# Agent Cards — especificación

> Qué es un **Agent Card**, cómo se emite, verifica, caduca y revoca. Basado en el código real del monorepo (`apps/issuer`, `apps/challenges`, `apps/resolver`, `packages/@cardca/*`).

## 1. Definición

Un **Agent Card** es el certificado de identidad de un agente software: una attestation firmada por CardCA, la Autoridad Certificadora (CA), que afirma que un `agentId` concreto posee ciertas capacidades (`capabilitiesHash`) y superó un reto de verificación (`challengeId`) en un intervalo de tiempo válido.

El nombre se toma del estándar de presentación web X.509: la attestation viaja como certificado en el campo **`x5c`** (certificate chain) de las peticiones ACME. Agent Card siempre se escribe en inglés, con mayúsculas iniciales — nunca "Tarjeta de Agente".

La identidad subyacente del agente está anclada on-chain en Base Sepolia (chainId 84532) como token soulbound en `AgentIdRegistry` (ver `docs/architecture.md` §6.1).

## 2. Formato lógico (EIP-712 `Attestation`)

La estructura firmada, definida en `packages/schemas/src/index.ts` (`AttestationStruct`) y usada bit a bit por el issuer y el verificador (`packages/sdk-verifier/src/index.ts`):

| Campo | Tipo | Contenido |
|---|---|---|
| `agentId` | `string` | Identificador del agente (no traducir; es semántica de campo). |
| `certType` | `string` | Tipo de certificado (p. ej. nivel de garantía del Agent Card). |
| `capabilitiesHash` | `bytes32` | Hash de las capacidades declaradas, validado por regex `^0x[0-9a-fA-F]{64}$`. |
| `challengeId` | `string` | Identificador del reto superado ( presente en la variante del issuer). |
| `issuedAt` | `uint64` | Época de emisión en milisegundos. |
| `expiresAt` | `uint64` | Época de caducidad; máximo `issuedAt + 24 h` (`MAX_ATTESTATION_VALIDITY_SECONDS`). |

Dominio EIP-712 canónico:

```json
{ "name": "CardCA", "version": "1", "chainId": 84532 }
```

La constante de marca vive en `@cardca/schemas` (`CARDCA_DOMAIN`); el alias `AGENT_ID_DOMAIN` queda deprecado por compatibilidad. Cualquier divergencia entre el dominio del firmante y el del verificador invalida la firma — ambos importan la misma definición.

## 3. Formato de transporte: X.509 `x5c` + ACME

CardCA usa **ACME** (el protocolo de RFC 8555, el mismo de Let's Encrypt) como protocolo de emisión:

- **Endpoints**: `acme.cardca.dev` (producción), `acme-staging.cardca.dev` (sandbox).
- El agente actúa como cliente ACME: demuestra control de la clave (account key) y recibe el certificado.
- La respuesta ACME entrega el **Agent Card como cadena de certificados X.509** en el campo `x5c` (JWS) / el campo certificado del AcmeCertificate: la hoja es el certificado del agente y la cadena asciende hasta la CA raíz de CardCA.
- Las URLs incrustadas en los certificados (CRL Distribution Points, AIA de certificados de emisores) usan los dominios cortos **`c.crdca.org`** (CRLs) e **`i.crdca.org`** (certs de emisores) — dominio documentado solo aquí, nunca al público.

La atadura criptográfica entre el certificado X.509 y el registro on-chain es el campo `capabilitiesHash` (bytes32) y el `agentId`: el certificado X.509 encapsula la misma estructura EIP-712 que `CertIssuer.issueAttestation()` verifica on-chain, de modo que un verificador puede contrastar el certificado con el estado del registry en Base Sepolia.

### 3.1 Flujo de emisión (resumen)

1. El operador registra al agente: attestation KYC del servicio `compliance` + mint soulbound con stake en `AgentIdRegistry`.
2. El agente crea un reto: `POST /challenge` en `@cardca/challenges`, y lo responde: `POST /challenge/:id/answer`.
3. Solicitud de emisión: `POST /attestation` en `@cardca/issuer` con `agentId`, `certType`, `capabilitiesHash`, `challengeId`.
4. El issuer comprueba el reto contra `challenges` (**fail-closed**: si el challenge service no está disponible o `passed !== true`, devuelve `403`).
5. El issuer firma la `Attestation` EIP-712 con la clave de la CA (`ISSUER_KEY`) y persiste el registro (tabla `attestations`, PK `agentId:challengeId`).
6. La attestation firmada se entrega también como certificado X.509 `x5c` vía ACME; el agente lo presenta en cada petición a gateways.

## 4. Verificación

Un verificador (p. ej. el gateway vía `@cardca/sdk-gateway`, o `POST /verify` del resolver) debe validar:

1. **Formato** — `sdk-verifier` hace asserts de formato: `agentId` no vacío, `certType` no vacío, `capabilitiesHash` bytes32 hex, fechas numéricas.
2. **Firma** — `verifyTypedData` de ethers contra el dominio `{ name: 'CardCA', version: '1', chainId }`; el signer debe ser una dirección emisora conocida.
3. **Ventana temporal** — `issuedAt ≤ ahora ≤ expiresAt`, y `expiresAt - issuedAt ≤ 24 h` (`MAX_ATTESTATION_VALIDITY_SECONDS`). Fuera de la ventana → `AttestationValidityError`.
4. **Cadena X.509** — cuando el card llega como `x5c`, validar la cadena hasta la raíz de CardCA y que los campos del certificado coincidan con la attestation.
5. **Estado on-chain** — el agente existe y no está quemado en `AgentIdRegistry` (`ownerOf`), la attestation es válida según `CertIssuer.isValid(agentId)`.
6. **Estado de revocación** — consulta de CRL (§6) o respuesta del resolver.

Los gateways usan `AttestationCache` (TTL) para no verificar en cada petición y `GatewayEnforcer` para decidir (allow/deny) combinando la verificación con la decisión de crédito (`CreditClient` → `GET /account/:agentId/decision`).

## 5. Caducidad

- **TTL fijo de 24 horas** (`TTL_MS` en `apps/issuer/src/main.ts`, `MAX_ATTESTATION_VALIDITY_SECONDS` en `@cardca/schemas`): los Agent Cards son de corta vida por diseño; el reconocimiento se re-emite con un nuevo reto.
- La caducidad es puramente temporal: el verificador compara `expiresAt` con el reloj; no hay mecanismo de renovación in-place — se emite un card nuevo.
- El replay está acotado por la ventana y por los nonces de servicio (`InMemoryNonceStore`, TTL 10 min, en `@cardca/sdk-auth`) en las llamadas entre servicios.

## 6. Revocación

- **CRLs** publicadas en `https://c.crdca.org` (CRL Distribution Point incrustado en cada certificado). Un verificador conforme comprueba la CRL antes de aceptar un card.
- Eventos que disparan revocación:
  - **Slashing**: `pob-api` (`POST /slash`, `GET /slash/:agentId`) y `BehaviorProof.slash(agentId)` on-chain tras disputas resueltas en contra.
  - **Baja de identidad**: `burnStake(agentId)` en `AgentIdRegistry` — el token soulbound se quema, y `CertIssuer.isValid(agentId)` deja de ser válido.
  - **Decisión de compliance** (KYC caducado — `KYC_EXPIRY = 7 days` — o borrado GDPR vía `compliance /erase/:agentId`).
- Los CRL se referencian con URLs cortas en `c.crdca.org` porque viajan dentro del campo CRL DP de cada certificado emitido.

## 7. Resumen de garantías

| Garantía | Mecanismo |
|---|---|
| Posesión de clave | Reto de `challenges` + firma ACME/EIP-712 |
| Identidad única no transferible | ERC-721 soulbound con stake (0.01 ETH mínimo) |
| KYC del operador | Firma EIP-712 del compliance signer, expira en 7 días |
| Corta vida / revocabilidad | TTL 24 h + CRLs en `c.crdca.org` + slashing |
| Anclaje verificable | Base Sepolia (84532): `AgentIdRegistry`, `CertIssuer`, `BehaviorProof` |
| Comportamiento demostrable | Proof-of-Behavior ZK (Noir) sobre receipts anclados |
