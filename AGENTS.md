# AGENTS.md — CardCA

Instrucciones para agentes de código que trabajen en este monorepo. El contrato completo de marca vive en **[`BRAND.md`](./BRAND.md)** — léelo antes de tocar textos, nombres de paquetes, variables de entorno o dominios.

## Qué es CardCA

**CardCA** — *"La Autoridad Certificadora de Agent Cards"* — es una CA pública para Agent Cards: emite certificados de identidad verificables para agentes software (X.509 `x5c` firmados por la CA, vía protocolo **ACME**). La identidad se ancla **on-chain en Base Sepolia** (registry de Agent Cards) y el comportamiento histórico del agente se acredita con **Proof-of-Behavior** (pruebas ZK). El intercambio entre agentes se liquida en el módulo de **interchange** con settlement.

Formas del nombre: `CardCA` (canónica, marca/UI/docs), `cardca` (lowercase técnico: paquetes, dominios, variables, identificadores). Nunca `Cardca`, `CARD CA` ni `CardC A`.

## Dominios

| Dominio | Rol |
|---|---|
| `cardca.org` | Marca pública: sitio, docs, CP/CPS, transparency log, status. |
| `cardca.dev` | Developers: `acme.cardca.dev` (ACME prod), `acme-staging.cardca.dev` (sandbox), `api.cardca.dev` (API pública). |
| `crdca.org` | Solo URLs incrustadas en certificados (`c.crdca.org` CRLs, `i.crdca.org` certs de emisores). No documentarlo al público. |

## Mapa del monorepo

Workspace pnpm (`pnpm-workspace.yaml`: `packages/*`, `apps/*`, `contracts`).

| Zona | Contenido |
|---|---|
| `apps/` | Servicios: `anchor` (anclaje on-chain), `challenges`, `compliance`, `credit`, `interchange` (settlement), `issuer` (CA/ACME), `pob-api` (Proof-of-Behavior), `portal-b2b`, `resolver`, `gateway-demo` (sin scope). |
| `packages/` | Librerías `@cardca/*`: `schemas`, `sdk-account`, `sdk-auth`, `sdk-gateway`, `sdk-receipts`, `sdk-verifier`. |
| `contracts/` | Contratos Solidity + Hardhat (`hardhat.config.ts`, `deployments.json`, `test/`, `scripts/`). |
| `zk/` | Circuits (circom: `dc_bench`, `dc_subbatch`, `distinct_counterparties*`), `lib/`, `tests/`, `tools/`. |
| `audit/` | Documentación de auditoría: scope, threat model, invariants, test plan, response plan, RFP, reporte Slither. |
| `governance/` | Charter, RFCs, log de decisiones. |
| `e2e/` | Scripts smoke/e2e en bash (`e2e-auth.sh`, `e2e-fase4.sh`, `railway-smoke.sh`, `verify-anchor.sh`). |
| `BRAND.md` | Contrato de marca (nombre, dominios, glosario, reglas de reemplazo, excepciones). |

## Convenciones

- **Gestor de paquetes:** pnpm (pinneado `pnpm@9.15.9` vía `packageManager`). No usar npm/yarn.
- **Node:** `>=22` (engines). En esta máquina: Node 24 arm64.
- **Scope npm:** todos los paquetes con scope usan `@cardca/*`.
- **Dominio EIP-712:** el `name` del dominio firmado es `'CardCA'` (antes `'AGENT.ID'`). Cualquier constante de dominio de marca nueva debe seguir este valor y tener asserts en tests.
- **Tests por paquete:** cada paquete define sus propios scripts `build`/`test` cuando aplica; la raíz los orquesta con `--if-present`.
- **Docs y marca en español; código/APIs e inglés** (identificadores, protocolos ACME/X.509, headers HTTP). Ver glosario en BRAND.md (p. ej. "Agent Card" nunca se traduce).
- **Idioma de commits/código:** seguir el estilo existente del paquete que toques.

## Variables de entorno

- Las variables de marca usan prefijo **`CARDCA_*`** (p. ej. `CARDCA_AGENT_ID`), y el código debe hacer **fallback a `AGENTID_*`** por compatibilidad durante la transición: `process.env.CARDCA_AGENT_ID ?? process.env.AGENTID_AGENT_ID`.
- `AGENTID_VOLUME_STEPS` es una constante TS (no env): renombrada a `CARDCA_VOLUME_STEPS` en código.
- **NO renombrar** variables semánticas de campo (`AGENT_ID`, `ANCHOR_AGENT_ID` en scripts e2e) ni `AGENT_ID_KEYS` (claves de lookup DB) — son semántica de "identificador de agente", no marca.

## Comandos clave

```bash
pnpm install            # regenerar pnpm-lock.yaml tras renombrar package.json (nunca editar el lock a mano)
pnpm build              # pnpm -r --if-present run build (incluye hardhat compile en contracts/)
pnpm test               # pnpm -r --if-present run test
pnpm --filter contracts exec hardhat test   # tests de contratos directamente
bash e2e/e2e-auth.sh    # e2e de autenticación (requiere servicios levantados)
bash e2e/railway-smoke.sh  # smoke contra servicios desplegados en Railway
```

## Excepciones de marca — NO renombrar

Ver la sección "Excepciones" de `BRAND.md` (y el inventario de reemplazos del rebrand en `docs/migration-agentid.md` si existe en tu rama). Resumen:

1. **URLs de servicios Railway** (`pob-api-production.up.railway.app`, `issuer-production-9388.up.railway.app`, `gateway-demo-production-6e65.up.railway.app`, `compliance-production-f8c6.up.railway.app`, `challenges-production.up.railway.app`, `resolver-production-87f2.up.railway.app`, `credit-production-677c.up.railway.app`) — servicios ya desplegados; solo cambian si se renombra el servicio en Railway.
2. **Secrets** (`secrets.*` en workflows de GitHub) — renombrar solo junto con la rotación real del secret.
3. **Valores on-chain desplegados** (direcciones/hashes en `contracts/deployments.json`, `contracts/deployments/`) — inmutables. Nombres de contratos en metadatos/docs sí se pueden tocar, pero verificar qué fixture está activo (localhost chainId 31337 vs Base Sepolia 84532) antes de renombrar `AgentIdRegistry` en artefactos comparados contra bytecode real.
4. **Campos semánticos `agentId` / `agent_id`** — identificador de agente en DB/APIs; no es marca.
5. **`.git/`** (incluye worktree `agentid-head`) — no se edita.
6. **`pnpm-lock.yaml`** — solo se regenera con `pnpm install`.
7. **Historial de commits y remotes** — renombrar remote/repo es decisión aparte.
