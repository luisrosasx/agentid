# Mapa de migración AGENT.ID → CardCA

> Contrato de marca: [`../BRAND.md`](../BRAND.md). Instrucciones del monorepo: [`../AGENTS.md`](../AGENTS.md).
> Estado: rebrand de código completado (Wave 2). Este documento registra **qué se cambió, qué se dejó intacto a propósito** y el plan para lo que queda.

## Contexto

AGENT.ID ("La CA de Agent Cards") se renombró a **CardCA**. La migración de código prioriza que el sistema siga funcionando: los identificadores ya desplegados on-chain, las URLs de servicios en producción y los datos existentes **no cambian con un rebrand de código**; se listan como migración posterior.

## Qué se renombró

### Scope npm

| Antes | Ahora |
|---|---|
| `@agentid/schemas`, `@agentid/sdk-account`, `@agentid/sdk-auth`, `@agentid/sdk-gateway`, `@agentid/sdk-receipts`, `@agentid/sdk-verifier` | `@cardca/*` (mismos nombres de paquete) |

`pnpm-lock.yaml` se regeneró con `pnpm install` (nunca se edita a mano). `gateway-demo` se mantiene sin scope.

### Dominio EIP-712

| Antes | Ahora |
|---|---|
| dominio `name: 'AGENT.ID'` (constante `AGENT_ID_DOMAIN` en `packages/*` y `apps/*`) | `name: 'CardCA'`, constante renombrada a `CARDCA_DOMAIN`, asserts en tests |

**⚠️ Recibos y firmas legacy:** todo recibo/firma EIP-712 producida con el dominio viejo `'AGENT.ID'` **no verifica** con el dominio nuevo. Opciones al verificar:

1. **Verificación dual (recomendada en transición):** intentar verificar con `'CardCA'` y, si falla, reintentar con `'AGENT.ID'` para datos históricos. El verificador acepta ambos pero marca la época del recibo.
2. **Bump de versión:** incrementar la versión del schema/recibo (p. ej. `v2`) y que los verificadores solo acepten `v2` a partir de una altura/block de corte; los recibos `v1` se verifican con el dominio viejo.

Decisión pendiente en `governance/` (RFC); mientras tanto, el comportamiento seguro es la verificación dual.

### Variables de entorno

| Antes | Ahora | Fallback |
|---|---|---|
| `AGENTID_AGENT_ID` (leída en `apps/anchor/src/onchain.ts`, `apps/interchange/src/settlement.ts`, `apps/pob-api/src/settlement.ts`, `e2e/verify-anchor.sh`) | `CARDCA_AGENT_ID` | `process.env.CARDCA_AGENT_ID ?? process.env.AGENTID_AGENT_ID` |

El código lee primero la variable `CARDCA_*` y hace **fallback a `AGENTID_*`** durante la transición, de modo que los entornos ya configurados (Railway, CI) siguen funcionando sin redeploys de configuración.

### Constantes de código

- `AGENTID_VOLUME_STEPS` (constante TS, no env — tabla de tiers de volumen del settlement en `apps/interchange/src/settlement.ts` y `apps/pob-api/src/settlement.ts`) → `CARDCA_VOLUME_STEPS`.
- Marca en textos, UI, docs, `audit/` y `governance/`: `AGENT.ID` / `AgentID` → `CardCA`.

## Qué quedó INTENCIONALMENTE sin renombrar

Estos elementos son identificadores técnicos o recursos desplegados; cambiarlos rompe compatibilidad y se tratan como migración de infraestructura, no de rebrand.

| Elemento | Motivo |
|---|---|
| **Campos semánticos `agentId` / `agent_id`** (DB, APIs, payloads) y `AGENT_ID_KEYS` (`['agent_id', 'agentId']`) | No es marca: significan "identificador de agente". Renombrar sería un cambio de schema/API. |
| **Variables semánticas de e2e** (`AGENT_ID`, `ANCHOR_AGENT_ID` en `e2e/*.sh`) | Ídem: identificadores de agente de prueba. |
| **Contrato `AgentIdRegistry` y su ABI** | El bytecode y las direcciones desplegadas son inmutables; el ABI y el nombre del contrato deben seguir coincidiendo con lo desplegado. En metadatos/docs puede mencionarse "CardCARegistry" como nombre aspiracional, pero el identificador de código no cambia mientras no haya redeploy. |
| **Columna(s) DB `agentid_bps`** | Migrar una columna implica migración de datos y despliegues coordinados; el nombre es histórico pero funcional. |
| **`certType` `AGENT.CERT`** | Valor codificado en certificados y lógica de comparación; cambiarlo invalidaría certificados existentes o exigiría dual-reading. |
| **Símbolo `AGID`** | Posiblemente referenciado en contratos/servicios ya desplegados; cambiar un símbolo on-chain no es posible sin redeploy. |
| **Nombres de servicios Railway y sus URLs** (`pob-api-production.up.railway.app`, `issuer-production-9388.up.railway.app`, `gateway-demo-production-6e65.up.railway.app`, `compliance-production-f8c6.up.railway.app`, `challenges-production.up.railway.app`, `resolver-production-87f2.up.railway.app`, `credit-production-677c.up.railway.app`) | Renombrar el servicio en Railway cambia la URL pública y rompe todos los consumidores (workflows, `e2e/railway-smoke.sh`, integraciones externas). Ver plan más abajo. |
| **Repo GitHub `agentid` y remote `origin`** | Renombrar el repo cambia URLs de git, workflows, badges y referencias. |
| **Secrets** (`secrets.*` en workflows) | Se renombran solo junto con la rotación real del secret. |
| **`.git/`** (incluye worktree `agentid-head`) | Infraestructura local; no se edita. |

## Plan de migración posterior

Orden sugerido (cada paso es una operación aparte, con su propia ventana y rollback):

1. **Recibos EIP-712:** decidir en governance entre verificación dual permanente (con cutoff) o bump de versión del schema. Implementar en `packages/sdk-receipts` y verificadores.
2. **Variables de entorno:** una vez actualizados los entornos Railway/CI a `CARDCA_AGENT_ID`, retirar el fallback a `AGENTID_*` (con log de warning antes).
3. **Renombrar repo GitHub** (`agentid` → `cardca` con `gh repo rename`): GitHub redirige automáticamente las URLs viejas; actualizar workflows, badges y cualquier URL hardcodeada en docs/README.
4. **Renombrar servicios Railway** uno a uno (p. ej. `issuer-production-9388` → `cardca-issuer`), actualizando en el mismo cambio: `e2e/railway-smoke.sh`, workflows y consumidores. Alternativa menos disruptiva: crear servicios nuevos con dominio `*.cardca.dev` apuntando a los mismos despliegues y mover el tráfico, retirando las URLs viejas al final.
5. **Dominios:** configurar DNS según `docs/domains.md`; sustituir URLs `*.agentid.example` por `api.cardca.dev`; los subdominios `c.crdca.org` / `i.crdca.org` se incrustan en nuevos certificados emitidos (los certificados viejos conservan sus URLs hasta expirar).
6. **Contratos (si procede):** evaluar redeploy del registry como `CardCARegistry` en Base Sepolia con migración de registros y evento de anuncio; mientras tanto el contrato `AgentIdRegistry` desplegado permanece como fuente de verdad. Solo después tocar metadatos/docs para reflejar el nuevo contrato.
7. **Base de datos:** migrar `agentid_bps` a `cardca_bps` (o renombrar con vista de compatibilidad) en una migración coordinada con los servicios que la leen.
8. **`certType` y símbolo `AGID`:** solo con un cambio de versión de protocolo que soporte ambos valores en lectura (dual) y escritura del nuevo.

## Checklist de verificación post-rebrand de código

- [x] `pnpm install` regenera el lock sin referencias a `@agentid/*` en `package.json`.
- [ ] `pnpm build` y `pnpm test` en verde (con asserts de dominio `'CardCA'`).
- [ ] `grep -r "@agentid/" --glob '!node_modules'` sin resultados fuera de `pnpm-lock.yaml` histórico/notas.
- [ ] `e2e/railway-smoke.sh` sigue en verde (no depende del rebrand).
- [ ] Fallback `CARDCA_AGENT_ID ?? AGENTID_AGENT_ID` funcionando en los tres servicios y `e2e/verify-anchor.sh`.
