# CardCA — Identidad de marca

## Nombre y tagline

**CardCA** — *"La Autoridad Certificadora de Agent Cards"*.

Variantes tipográficas (según contexto):

- `CardCA` — forma canónica (marca, UI, docs).
- `CardCA` en mayúsculas en logos/cabeceras si el estilo lo pide (no usar `Cardca` ni `CARD CA`).
- `cardca` — forma técnica (lowercase): paquetes, dominios, variables, identificadores.

## Misión

CardCA es una **CA pública para Agent Cards**: emite certificados de identidad verificables para agentes software. Un agente demuestra posesión de una clave y CardCA le emite un **Agent Card** — un certificado X.509 (`x5c`) firmado por la CA — mediante el protocolo **ACME**. La identidad se ancla **on-chain en Base Sepolia** (registry de Agent Cards) y el comportamiento histórico del agente se acredita con **Proof-of-Behavior** (pruebas ZK). El intercambio entre agentes se liquida en el módulo de **interchange** con settlement.

## Dominios

| Dominio | Rol |
|---|---|
| `cardca.org` | Marca pública: sitio, documentación, CP/CPS (Certificate Policy / Certificate Practice Statement), transparency log, página de status. |
| `cardca.dev` | Dominio para desarrolladores: `acme.cardca.dev` (ACME producción), `acme-staging.cardca.dev` (sandbox ACME), `api.cardca.dev` (API pública). |
| `crdca.org` | Solo para URLs incrustadas dentro de los certificados: `c.crdca.org` (CRLs), `i.crdca.org` (certs de emisores). Se usa un dominio corto porque estas URLs viajan en el campo `x5c`/CRL DP de cada certificado y cada byte cuenta. |

Regla: el público final nunca ve `crdca.org` documentado; solo aparece dentro de certificados emitidos. Toda comunicación de marca y developer experience vive en `cardca.org` / `cardca.dev`.

## Tono

- Técnico, directo y preciso; español para docs y marca, inglés para código/APIs (nombres de identificadores, protocolos ACME/X.509, headers HTTP).
- Evitar calificar el producto con superlativos de marketing; usar afirmaciones verificables ("verificable", "firmado por la CA", "anclado on-chain").

## Glosario

| Término | Uso | Notas ES/EN |
|---|---|---|
| **Agent Card** | El certificado de identidad de un agente (X.509, `x5c`). Siempre en inglés, con mayúsculas iniciales. No traducir ("Tarjeta de Agente" ✗). | EN fijo |
| **CA** | Autoridad Certificadora (CardCA). Primera mención: "la Autoridad Certificadora (CA)". | ES: Autoridad Certificadora · EN: Certificate Authority |
| **CardCA** | La marca. Nunca referirse a ella como "la CA CardCA" redundante en titulares; en cuerpo sí: "CardCA, la CA de Agent Cards". | marca |
| **emisión** | Proceso de emitir un Agent Card vía ACME. | ES: emisión / emitir · EN: issuance / issue |
| **verificación** | Validar un Agent Card (cadena, `x5c`, estado via CRL, anclaje on-chain). | ES: verificación / verificar · EN: verification / verify |
| **settlement** | Liquidación del interchange entre agentes. Se prefiere el anglicismo. | ES/EN: settlement |
| **Proof-of-Behavior** | Acreditación ZK del comportamiento del agente. En inglés, guiones como está. | EN fijo |
| **anchor / anchoring** | Publicación on-chain en Base Sepolia del registry. ES: "anclaje on-chain". | ES: anclaje · EN: anchoring |

## Mapa de reemplazos (inventario real del monorepo)

Inventario hecho con `grep -rli "agent\.id\|agentid"` (excluyendo `node_modules` y `.git`):

### Conteos por zona (archivos que mencionan la marca vieja)

| Zona | Archivos afectados |
|---|---|
| `apps/` | 129 |
| `packages/` | 46 |
| `contracts/` | 36 |
| `zk/` | 8 |
| `audit/` | 6 |
| `governance/` | 4 |
| raíz (`e2e/`, `.github/workflows/`, `package.json`, `pnpm-lock.yaml`) | ~14 |

Total ≈ 243 archivos (sin contar `.git`).

### Patrones detectados y frecuencias (case-insensitive, todo el repo)

| Patrón | Ocurrencias aprox. | Notas |
|---|---|---|
| `agentid` (cualquier forma) | 2170 | total agregado |
| `@agentid/` | 140 | scopes de paquetes pnpm |
| `AGENT.ID` | 92 | nombre de marca en textos/constantes |
| `AGENT_ID` / `agentId` / `agent_id` | 83+ | mayormente semántica de campo "identificador de agente", NO marca — revisar caso por caso |

### Reglas de reemplazo

| Viejo | Nuevo |
|---|---|
| `AGENT.ID` (marca, textos, UI) | `CardCA` |
| `AgentID` (camelCase de marca) | `CardCA` |
| `agentid` (identificadores, dominios, nombres de archivo) | `cardca` |
| `@agentid/` (scope npm) | `@cardca/` |
| `AGENTID_X` (variables de entorno de marca) | `CARDCA_X` — el código lee primero `CARDCA_X` y hace **fallback a `AGENTID_X`** por compatibilidad durante la transición |
| URLs `https://resolver.agentid.example` / `https://credit.agentid.example` | URLs reales bajo `api.cardca.dev` (o dominios de servicio definitivos) cuando se definan |
| `gateway-demo` (nombre de paquete sin scope) | se mantiene sin scope; renombrar solo si se decide darlo de alta como `@cardca/gateway-demo` |

### Variables de entorno detectadas

- **`AGENTID_AGENT_ID`** — variable real de entorno leída del `env` en runtime (`apps/anchor/src/onchain.ts`, `apps/interchange/src/settlement.ts`, `apps/pob-api/src/settlement.ts`, `e2e/verify-anchor.sh`) → renombrar a `CARDCA_AGENT_ID` con fallback.
- **`AGENT_ID` / `ANCHOR_AGENT_ID`** — usadas en scripts `e2e/*.sh` como identificadores de agente de prueba (semántica de campo, no de marca). NO renombrar como marca; solo si se decide unificar semántica.
- **`AGENTID_VOLUME_STEPS`** — NO es variable de entorno: es una constante TypeScript (tabla de tiers de volumen del settlement) en `apps/interchange/src/settlement.ts` y `apps/pob-api/src/settlement.ts`. Renombrar a `CARDCA_VOLUME_STEPS` como constante de código.
- **`AGENT_ID_DOMAIN`** — constante TS exportada (config de dominio de marca, con `name: 'AGENT.ID'` y asserts en tests en `packages/*` y `apps/*`) → renombrar a `CARDCA_DOMAIN` (o `BRAND_DOMAIN`) y actualizar el valor a `CardCA` + asserts.
- **`AGENT_ID_KEYS`** — constante TS (`['agent_id', 'agentId']`, claves de lookup de DB) → semántica de campo; se mantiene salvo decisión contraria.

### Nombres de servicios Railway (NO tocar)

Referenciados en `e2e/railway-smoke.sh` y workflows — corresponden a servicios ya desplegados:

- `pob-api-production.up.railway.app`
- `issuer-production-9388.up.railway.app`
- `gateway-demo-production-6e65.up.railway.app`
- `compliance-production-f8c6.up.railway.app`
- `challenges-production.up.railway.app`
- `resolver-production-87f2.up.railway.app`
- `credit-production-677c.up.railway.app`

Estas URLs solo cambian si se renombra el servicio en Railway (operación aparte, no de rebrand de código).

### Excepciones (identificadores técnicos que NO se tocan)

1. **URLs de servicios Railway** de la lista anterior (mientras no se renombren los servicios).
2. **Secrets** y nombres de variables de entorno definidos en Railway/GitHub (`secrets.*` en workflows): renombrar solo junto con la rotación real del secret.
3. **Valores on-chain ya desplegados** (direcciones en `contracts/deployments.json`, `contract/deployments/`): las direcciones y hashes son inmutables. **Los nombres de contratos SÍ se pueden tocar** en metadatos/comentarios/ABI names en el repositorio, porque `deployments.json` es fixture de localhost (chainId 31337) — pero si el workflow `anchor-real.yml` ya desplegó a Base Sepolia (chainId 84532, commit de `deployments.json`), verificar qué fixture está activo antes de renombrar `AgentIdRegistry` en cualquier artefacto que se compare contra bytecode/direcciones reales. Nombres candidatos: `AgentIdRegistry` → `CardCARegistry` (solo en metadatos/documentación si hay deploy real; el bytecode existente no cambia).
4. **Campos semánticos `agentId` / `agent_id` / `AGENT_ID_KEYS`** (identificador de agente en DB/APIs): NO es marca, NO tocar en esta fase.
5. **`.git/`** (incluye el worktree `agentid-head`): no se edita; el renombrado del repo/worktree es operación de infraestructura aparte.
6. **`pnpm-lock.yaml`**: se regenera con `pnpm install` tras renombrar los `package.json`; nunca a mano.
7. **Historial de commits y remotes** (`origin` apuntando al repo `agentid`): renombrar remote/repo es decisión aparte.
