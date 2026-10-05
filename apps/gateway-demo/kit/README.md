# AGENT.ID — Kit de integración gateway (<15 min)

Integra un gateway externo con AGENT.ID: atestaciones AGENT.CERT, enforcement
de permisos A2A y recibos bilaterales. Todo el flujo de este README se
verifica automáticamente con el script de onboarding:

```bash
pnpm --filter gateway-demo kit:onboard
```

El script arranca el demo gateway en local (test harness con resolver y
crédito simulados), ejecuta los 6 pasos y mide el tiempo total. Sale con
código 0 solo si todos los pasos verifican.

## Prerequisitos

- Node ≥ 22 y pnpm (monorepo `agentid/`)
- Un gateway que pueda llamar HTTP JSON (Fastify/Express/lo que sea)

## Paso 0 — Dependencias (1 min)

Desde la raíz del monorepo:

```bash
pnpm install
```

Tu gateway consume los SDKs públicos: `@agentid/sdk-auth` (auth de servicio +
HMAC), `@agentid/sdk-receipts` (recibos bilaterales EIP-712) y, si quieres el
motor de decisiones embebido, `@agentid/sdk-gateway` (`GatewayEnforcer`).

## Paso 1 — Obtener la service key (2 min)

El gateway de AGENT.ID autentica llamadas de servicio con `X-Service-Key`.
En local, el gateway corre con `AUTH_MODE=off` (sin auth) por defecto; en
producción (`AUTH_MODE=on`) la key debe estar en la lista
`SERVICE_AUTH_KEYS` (separada por comas) configurada por el operador:

```bash
# lado del gateway demo
SERVICE_AUTH_KEYS=sk-tu-key-abc123 AUTH_MODE=on pnpm --filter gateway-demo start

# lado de tu integración: envía la key en cada request
curl -s http://localhost:3200/healthz
curl -s -X POST http://localhost:3200/enforce \
  -H "content-type: application/json" \
  -H "x-service-key: sk-tu-key-abc123" \
  -d '{"agentId":"agent:mi-agente","target":"0x1111111111111111111111111111111111111111","amountWei":"1000"}'
```

Respuesta de `/enforce`: `{ decision: "allow" | "deny", reason, latencyMs,
degraded }` — `deny` siempre con 403 (fail-closed: sin atestación válida,
sin política de crédito o sin allowlist de targets, se niega).

## Paso 2 — Firma HMAC (3 min, opcional pero recomendado)

Para endpoints sensibles (settlement, emisión) el esquema compartido es HMAC
SHA-256 sobre `METHOD\nPATH\nsha256(body)`, con cabeceras `x-service-id`,
`x-timestamp` (ventana de 5 min) y `x-signature`, más protección anti-replay
por nonce. Helper ya listo:

```ts
import { computeHmacSignature, sha256Hex } from '@agentid/sdk-auth';

const body = JSON.stringify(payload);
const signature = computeHmacSignature('POST', '/enforce', sha256Hex(body), secret);
// headers: { 'x-service-id': 'tu-gateway', 'x-timestamp': String(Date.now()), 'x-signature': signature }
```

El lado receptor aplica `requireHmac({ secrets: { 'tu-gateway': secret } })`
del mismo paquete (verifica firma, ventana de tiempo y replay).

## Paso 3 — Enforcement en el hot path (5 min)

Dos caminos equivalentes:

1. **Llamar al gateway HTTP** (arriba): tu gateway pregunta por cada
   interacción A2A y aplica la decisión.
2. **Embeber el enforcer** (misma decisión, latencia <1 ms en cache):

```ts
import { GatewayEnforcer } from '@agentid/sdk-gateway';

const enforcer = new GatewayEnforcer({
  resolverUrl: 'https://resolver.agentid.example',   // sirve atestaciones
  creditUrl: 'https://credit.agentid.example',       // política de crédito
  allowedTargetsByAgent: { 'agent:mi-agente': ['0x11…'] },
});
const decision = await enforcer.enforce('agent:mi-agente', target, amountWei);
```

La decisión combina atestación vigente (cache local), límite diario de
crédito y allowlist de targets. Nunca falla abierto.

## Paso 4 — Enviar recibos / records (3 min)

Cada interacción A2A permitida puede dejar un recibo bilateral firmado
(EIP-712), que luego se ancla por lotes (Merkle) en el interchange:

```ts
import { Wallet } from 'ethers';
import { signReceipt, verifyReceipt, receiptDigest, merkleRoot } from '@agentid/sdk-receipts';
import type { BilateralReceiptMessage } from '@agentid/sdk-receipts';

const receipt: BilateralReceiptMessage = {
  agentId: 'agent:mi-agente',
  counterpartyId: 'counterparty:tu-gateway',
  counterpartyStakeRoot: '0x' + '0'.repeat(64), // root de stake de la contraparte
  a2aTaskHash: '0x' + '0'.repeat(64),           // hash de la tarea A2A
  outcome: 1,                                    // código de resultado 0-255
  digest: '0x' + '0'.repeat(64),                 // hash del payload
  timestamp: BigInt(Math.floor(Date.now() / 1000)),
};
const signed = await signReceipt(receipt, walletDelGateway);
// enviar { ...signed } al endpoint de records del interchange
verifyReceipt(signed, walletDelGateway.address); // true
```

Los recibos se agregan en árboles de Merkle (`merkleRoot`) que el anchor
publica on-chain.

## Paso 5 — Verificar estado (1 min)

- `GET /healthz` → `{ status: "ok" }`
- `GET /metrics` → `{ decisions: { allow, deny }, totalDecisions,
  p99LatencyMs, deniesByReason, fallbackTotal }` — úsalo para tu propio
  dashboard y para el KPI de latencia p99 del blueprint 04.

## Criterio de listo

Los 6 pasos del script pasan:

```
[PASS] 1. healthcheck …
[PASS] 2. service key + enforce (allow) …
[PASS] 3. enforce fail-closed (deny) …
[PASS] 4. firma HMAC …
[PASS] 5. recibo bilateral firmado + verificado …
[PASS] 6. métricas de enforcement …
Onboarding end-to-end: OK en X.XX s
```

Si algo falla, revisa `AUTH_MODE`/`SERVICE_AUTH_KEYS` (paso 1) y que el
resolver sirva atestaciones firmadas con el dominio EIP-712
`AGENT.ID/1/chainId` correcto.
