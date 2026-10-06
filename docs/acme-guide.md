# CardCA — Guía del desarrollador: pedir un Agent Card por ACME

Esta guía explica, paso a paso y con clientes reales, cómo un agente software demuestra su identidad y obtiene un **Agent Card** de CardCA, la Autoridad Certificadora (CA) de Agent Cards.

## Endpoints oficiales

| Entorno | URL | Uso |
|---|---|---|
| ACME producción | `https://acme.cardca.dev` | Emisión de Agent Cards en producción. |
| ACME sandbox | `https://acme-staging.cardca.dev` | Pruebas: certificados de prueba, sin cuotas reales. Empieza siempre aquí. |
| API pública | `https://api.cardca.dev` | Servicios REST: `resolver` (verificación), `credit` (política), `pob-api` (Proof-of-Behavior), `compliance`, `anchor` (anclaje on-chain). Ver [`api-reference.md`](./api-reference.md). |

Las URLs incrustadas dentro de los certificados (`c.crdca.org` para CRLs, `i.crdca.org` para certs de emisores) son internas del certificado `x5c`: nunca las consumes directamente.

## Cómo funciona la emisión (modelo ACME)

La emisión sigue el modelo de reto-respuesta del protocolo ACME, mapeado a los servicios del monorepo:

1. **Cuenta** — el agente genera (o reutiliza) su clave Ethereum. La dirección de esa clave es su identidad criptográfica.
2. **Authorization (challenge)** — el agente pide un reto de comportamiento al servicio `challenges` (`POST /challenge`). CardCA devuelve un `prompt` y un `nonce` con validez de 300 segundos.
3. **Challenge response** — el agente responde con el valor correcto (`POST /challenge/:id/answer`). Si es correcto, el reto queda `passed: true` con un `proofHash` de evidencia.
4. **Order (emisión)** — el agente llama al servicio `issuer` (`POST /attestation`) con `agentId`, `certType`, `capabilitiesHash` y el `challengeId` aprobado. El issuer comprueba el challenge contra `challenges` y, si es válido, firma la atestación (la Agent Card) con la clave de la CA mediante EIP-712.
5. **Certificado** — la respuesta contiene la atestación (`attestation`), la firma de la CA (`signature`), la dirección del emisor (`issuer`) y el `digest` EIP-712. La Agent Card es vigente 24 horas; renuévala repitiendo el flujo.
6. **Publicación on-chain** — de forma asíncrona, el servicio `anchor` agrega las atestaciones en un árbol de Merkle y ancla la raíz en Base Sepolia (contrato `BehaviorProof`). Puedes verificar la inclusión con una Merkle proof (`GET /anchors/:batchId/proof/:leafHash`).
7. **Verificación por terceros** — cualquiera puede validar la Agent Card contra el resolver público (`https://api.cardca.dev/resolver`) o localmente con `@cardca/sdk-verifier`.

En el sandbox todo el flujo es idéntico; solo cambia la base URL (`acme-staging.cardca.dev`) y las claves de la CA son distintas de las de producción. Un Agent Card emitido en sandbox **no** verifica en producción y viceversa: el `chainId` del dominio EIP-712 y la dirección del issuer lo separan.

## Paso a paso con cliente HTTP (flujo nativo)

Este es el flujo que las apps del monorepo implementan hoy; úsalo para integrarte sin librería ACME.

### Paso 0 — Prepara tu identidad

```bash
# con ethers v6 (Node ≥ 22)
node -e "import('ethers').then(({Wallet})=>{const w=Wallet.createRandom();console.log(w.address, w.privateKey)})"
```

Guarda la clave privada de forma segura: es la clave de tu agente. Con ella firmarás recibos bilaterales y (según el servicio) mensajes EIP-712.

### Paso 1 — Solicita un reto (Authorization)

```bash
curl -s -X POST https://acme-staging.cardca.dev/challenge \
  -H 'content-type: application/json' \
  -H "x-service-key: $CARDCA_SERVICE_KEY" \
  -d '{"agentId":"agent:mi-agente"}'
```

Respuesta `201`:

```jsonc
{
  "id": "9f2c…",          // challengeId
  "agentId": "agent:mi-agente",
  "prompt": "sha256 hex",
  "nonce": "hex32",       // ← la respuesta correcta es este nonce
  "expiresAt": 1760000000000  // 300 s de ventana
}
```

Con auth activa (`AUTH_MODE≠off`) todas las rutas de servicio exigen `X-Service-Key` (te la asigna el operador de CardCA; en sandbox se gestiona en el portal). Sin cabecera, `401`.

### Paso 2 — Responde el reto

```bash
curl -s -X POST https://acme-staging.cardca.dev/challenge/$CHALLENGE_ID/answer \
  -H 'content-type: application/json' \
  -H "x-service-key: $CARDCA_SERVICE_KEY" \
  -d "{\"answer\":\"$NONCE\"}"
```

- `200 { "passed": true, "proofHash": "0x…" }` → reto aprobado, continúa.
- `403 { "passed": false }` → respuesta incorrecta; pide un reto nuevo.
- `410` → el reto expiró (300 s); pide uno nuevo.

### Paso 3 — Pide la emisión (Order)

```bash
curl -s -X POST https://acme-staging.cardca.dev/attestation \
  -H 'content-type: application/json' \
  -H "x-service-key: $CARDCA_SERVICE_KEY" \
  -d "{
    \"agentId\": \"agent:mi-agente\",
    \"certType\": \"AGENT.CERT\",
    \"capabilitiesHash\": \"0x$(printf 'a%.0s' {1..64})\",
    \"challengeId\": \"$CHALLENGE_ID\"
  }"
```

- `403 { "error": "challenge not passed" }` → el issuer consultó el reto y no estaba aprobado; repite pasos 1–2.
- `201` → tu Agent Card:

```jsonc
{
  "attestation": {
    "agentId": "agent:mi-agente",
    "certType": "AGENT.CERT",
    "capabilitiesHash": "0xaaa…",
    "challengeId": "9f2c…",
    "issuedAt": 1760000000000,
    "expiresAt": 1760086400000   // issuedAt + 24 h
  },
  "signature": "0x…",   // firma EIP-712 de la CA
  "issuer": "0x…",      // dirección de la CA
  "digest": "0x…"       // digest EIP-712 codificado
}
```

`capabilitiesHash` es un `bytes32` que resume las capacidades declaradas del agente (hash del manifiesto de capacidades).

### Paso 4 — Guarda y reutiliza tu Agent Card

La tupla `{ attestation, signature, issuer }` es lo que presentas ante gateways y servicios (verifica vía `POST /verify` del resolver o cache local). Caduca en 24 h: programa la renovación antes del vencimiento repitiendo pasos 1–3.

## Paso a paso con cliente ACME genérico

Los clientes ACME estándar (certbot, acme.sh, lego) hablan el protocolo de reto-respuesta sobre un directory ACME. CardCA expone la misma semántica en `acme.cardca.dev` / `acme-staging.cardca.dev`. Mapeo conceptual:

| Concepto ACME | En CardCA |
|---|---|
| ACME directory | `https://acme-staging.cardca.dev/directory` |
| New account | Registro de la clave del agente (dirección Ethereum) |
| New order | `POST /challenge` + `POST /attestation` (servicios `challenges` + `issuer`) |
| Identifier authorization | Reto de comportamiento (`prompt`/`nonce`, TTL 300 s) |
| Finalize / certificate | Attestation firmada EIP-712 (Agent Card, vigencia 24 h) |

Ejemplo con `lego` (esqueleto; el provider de reto se resuelve contra los endpoints CardCA):

```bash
ACME_SERVER=https://acme-staging.cardca.dev/directory \
lego --server "$ACME_SERVER" \
     --email ops@tu-empresa.example \
     --dns lego-provider-cardca \        # provider que responde el reto CardCA
     --domains agent:mi-agente \
     run
```

> Nota: si tu cliente ACME no soporta el provider CardCA todavía, usa el flujo HTTP nativo del apartado anterior — es exactamente el mismo protocolo expuesto como REST y es lo que el monorepo implementa y testea hoy (`apps/challenges`, `apps/issuer`).

## Verificar una Agent Card recibida

**Remota (resolver público):**

```bash
# resolución por agentId
curl -s https://api.cardca.dev/resolver/resolve/agent:mi-agente
# → { "valid": true, "attestation": {…}, "signature": "0x…", "issuer": "0x…", "digest": "0x…" }

# verificación de una card que te presentaron
curl -s -X POST https://api.cardca.dev/resolver/verify \
  -H 'content-type: application/json' \
  -d '{"attestation":{…},"signature":"0x…","issuer":"0x…"}'
```

`valid: false` con `reason` (`expired`, `issuer mismatch`, `invalid signature`, `not found`).

**Local (TypeScript, `@cardca/sdk-verifier`):**

```ts
import { verifyAttestation, DOMAIN, ATTESTATION_TYPES } from '@cardca/sdk-verifier';

const { signer, attestation } = verifyAttestation(att, issuerAddress, signature);
// lanza AttestationFormatError si la card está malformada o expirada
```

El verificador exige que el dominio EIP-712 sea `{ name: 'CardCA', version: '1', chainId }` bit a bit — una card emitida por otra CA o con otro `chainId` falla.

## Checklist de producción

- [ ] Usa `acme.cardca.dev` (producción) solo con agentes verificados; todo lo demás, en `acme-staging.cardca.dev`.
- [ ] Guarda `ISSUER`/`signature` y verifica con `@cardca/sdk-verifier` antes de confiar en una card de terceros.
- [ ] Renueva antes de 24 h; los gateways fallan cerrado (deny) ante cards expiradas.
- [ ] Si actuas como gateway, aplica enforcement con `@cardca/sdk-gateway` (`GatewayEnforcer`) — nunca aceptes una interacción sin card válida.
- [ ] No expongas la clave privada del agente; firma recibos bilaterales con ella (`@cardca/sdk-receipts`).
