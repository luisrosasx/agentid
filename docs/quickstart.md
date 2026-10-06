# CardCA — Quickstart (15 minutos)

De cero a emitir y verificar una Agent Card en local. Al final te indicamos cómo apuntar al sandbox (`acme-staging.cardca.dev`) sin cambiar tu código.

## Requisitos

- **Node ≥ 22** (el monorepo declara `engines.node >= 22`; probado con Node 24).
- **pnpm 9** (pinneado `pnpm@9.15.9` vía `packageManager`). Si no lo tienes: `corepack enable && corepack prepare pnpm@9.15.9 --activate`.
- No se requiere Postgres ni Redis para este quickstart: los servicios funcionan con almacenamiento en memoria.

## Paso 1 — Clona e instala (2 min)

```bash
git clone <url-del-repo> cardca && cd cardca
pnpm install
```

## Paso 2 — Build (2 min)

```bash
pnpm build
```

Esto ejecuta `pnpm -r --if-present run build` en todos los paquetes del workspace (`packages/*`, `apps/*`, `contracts`).

## Paso 3 — Levanta el issuer (2 min)

Terminal 1:

```bash
cd apps/issuer
ISSUER_KEY=0x0000000000000000000000000000000000000000000000000000000000000001 \
CHAIN_ID=31337 \
TRUST_CHALLENGES=true \
PORT=3000 \
pnpm start
```

- `ISSUER_KEY`: clave privada de la CA. Sin ella, el servicio genera una efímera (solo dev; verás un warning).
- `TRUST_CHALLENGES=true`: salta la verificación del challenge (útil para la primera prueba; quítalo para el flujo completo con `challenges`).
- `CHAIN_ID=31337` (red hardhat local) debe coincidir entre emisor y verificador.

Verifica: `curl -s http://localhost:3000/healthz` → `{"ok":true,"service":"issuer"}`.

## Paso 4 — Levanta el resolver (2 min)

Terminal 2:

```bash
cd apps/resolver
CHAIN_ID=31337 \
PORT=3001 \
pnpm start
```

Verifica: `curl -s http://localhost:3001/healthz` → `{"ok":true,"service":"resolver"}`.

> Nota: en este quickstart el resolver arranca vacío (la cache se llena vía `POST /verify`). Para que `GET /resolve/:agentId` sirva la card, emite con el paso 5 y luego haz el `POST /verify` del paso 6.

## Paso 5 — Emite una Agent Card (3 min)

```bash
curl -s -X POST http://localhost:3000/attestation \
  -H 'content-type: application/json' \
  -d '{
    "agentId": "agent:quickstart",
    "certType": "AGENT.CERT",
    "capabilitiesHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "challengeId": "quickstart-challenge"
  }'
```

Respuesta `201`:

```jsonc
{
  "attestation": {
    "agentId": "agent:quickstart",
    "certType": "AGENT.CERT",
    "capabilitiesHash": "0xaaa…",
    "challengeId": "quickstart-challenge",
    "issuedAt": 1760000000000,
    "expiresAt": 1760086400000
  },
  "signature": "0x…",
  "issuer": "0x…",
  "digest": "0x…"
}
```

Guarda el JSON completo; es tu Agent Card (vigente 24 h).

<details>
<summary>Flujo completo con challenges (sin TRUST_CHALLENGES)</summary>

Levanta también `apps/challenges` (`pnpm start`, puerto 3002) y arranca el issuer con `CHALLENGES_URL=http://localhost:3002` en lugar de `TRUST_CHALLENGES=true`:

```bash
CH=$(curl -s -X POST localhost:3002/challenge -H 'content-type: application/json' \
     -d '{"agentId":"agent:quickstart"}')
CID=$(echo "$CH" | jq -r .id); NONCE=$(echo "$CH" | jq -r .nonce)
curl -s -X POST localhost:3002/challenge/$CID/answer \
  -H 'content-type: application/json' -d "{\"answer\":\"$NONCE\"}"   # passed: true
# luego POST /attestation en el issuer con "challengeId": "$CID"
```

La respuesta correcta del reto es el `nonce` devuelto (los detalles están en `docs/api-reference.md`, servicio `challenges`).

</details>

## Paso 6 — Verifica la card (2 min)

Contra el resolver local:

```bash
curl -s -X POST http://localhost:3001/verify \
  -H 'content-type: application/json' \
  -d @card.json    # guarda antes la respuesta del paso 5 en card.json
# → { "valid": true, "attestation": {…}, "issuer": "0x…" }
```

Y localmente, sin red, con el SDK:

```ts
import { verifyAttestation } from '@cardca/sdk-verifier';

const { signer, attestation } = verifyAttestation(
  att.attestation,
  att.issuer,
  att.signature,
);
console.log('Agent Card válida, firmada por', signer);
```

El verificador valida formato, vigencia (24 h), dominio EIP-712 `{ name: 'CardCA', version: '1', chainId: 31337 }` y que la firma recupere la dirección del issuer.

## Paso 7 — Siguientes pasos opcionales

- **Anclaje on-chain:** levanta `apps/anchor` con `ANCHOR_MODE=sim` (obligatorio: sin esa variable la app no arranca) y `DATABASE_URL` opcional. Para modo real en Base Sepolia necesitas `ANCHOR_MODE=real`, `DEPLOYER_PRIVATE_KEY` y `contracts/deployments.json`.
- **Enforcement como gateway:** sigue `apps/gateway-demo/kit/README.md` — onboarding automático con `pnpm --filter gateway-demo kit:onboard`.
- **Recibos y Proof-of-Behavior:** `apps/pob-api` (`POST /receipt`, `GET /score/:agentId`).
- **Referencia completa de rutas y payloads:** [`api-reference.md`](./api-reference.md).
- **Emisión vía ACME contra los endpoints oficiales:** [`acme-guide.md`](./acme-guide.md).

## Apuntar al sandbox

En desarrollo tu código habla con `http://localhost:<puerto>`. Para pasar a sandbox sin reescribir nada, sustituye las bases URL:

| Servicio local | Endpoint sandbox |
|---|---|
| `http://localhost:3000` (issuer, emisión ACME) | `https://acme-staging.cardca.dev` |
| `http://localhost:3001` (resolver) | `https://api.cardca.dev/resolver` |
| `http://localhost:3002` (challenges) | `https://acme-staging.cardca.dev` |
| `http://localhost:3003` (credit) | `https://api.cardca.dev/credit` |

Diferencias a tener en cuenta:

1. **Autenticación:** en local corre con `AUTH_MODE=off`. El sandbox exige `X-Service-Key` en cada request (te la asigna el operador) y los endpoints de emisión exigen además firma HMAC (`HMAC_SECRETS`, ver api-reference).
2. **chainId:** el sandbox usa el `chainId` de Base Sepolia (`84532`), no `31337`. Una card emitida localmente no verifica en sandbox ni viceversa.
3. **Claves:** las claves de la CA del sandbox son distintas de las de producción. Configura la dirección del issuer esperado antes de verificar cards de terceros.

Para producción (`acme.cardca.dev`) el flujo es idéntico al sandbox; consulta la checklist final de [`acme-guide.md`](./acme-guide.md).

## Solución de problemas

| Síntoma | Causa habitual |
|---|---|
| `403 challenge not passed` en `/attestation` | El `challengeId` no está aprobado: usa `TRUST_CHALLENGES=true` o completa el flujo con `apps/challenges`. |
| `404 { valid: false, reason: "expired" }` | La card superó las 24 h: vuelve a emitir. |
| `404 { valid: false, reason: "issuer mismatch" }` | El dominio EIP-712 (`CHAIN_ID`) difiere entre quien firma y quien verifica. |
| `401 unauthorized` | `AUTH_MODE≠off` y falta `X-Service-Key` válida (`SERVICE_AUTH_KEYS`). |
| anchor no arranca | Falta `ANCHOR_MODE` (fail-closed: `sim` para local, `real` con claves para Base Sepolia). |
