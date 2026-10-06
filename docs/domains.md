# CardCA — Mapa de dominios y DNS

> Referencia de marca: [`../BRAND.md`](../BRAND.md) (sección "Dominios").
> Regla general: el público final nunca ve `crdca.org` documentado; solo aparece dentro de certificados emitidos.

## Roles por dominio

| Dominio | Rol | Público |
|---|---|---|
| `cardca.org` | **Marca pública**: sitio web, documentación, CP/CPS (Certificate Policy / Certificate Practice Statement), transparency log (`log.cardca.org`, ver `transparency-log.md`), página de status. | Sí |
| `cardca.dev` | **Developers**: endpoints operativos del protocolo ACME y de la API pública. | Sí (developers que integran) |
| `crdca.org` | **Solo URLs incrustadas en certificados**: `c.crdca.org` (CRLs), `i.crdca.org` (certificados de emisores). Nunca se documenta al público. | No |

## Subdominios previstos

### `cardca.org`

| Subdominio | Uso |
|---|---|
| `cardca.org` (apex) | Sitio de marca, landing. |
| `docs.cardca.org` | Documentación (estos docs, CP/CPS). |
| `log.cardca.org` | Transparency log de certificados emitidos (API pública, ver `transparency-log.md`). |
| `status.cardca.org` | Página de estado de servicios. |

### `cardca.dev`

| Subdominio | Uso |
|---|---|
| `acme.cardca.dev` | Directorio ACME de **producción** (emisión de Agent Cards). |
| `acme-staging.cardca.dev` | Sandbox ACME para pruebas de integración. |
| `api.cardca.dev` | API pública (resolver, credit, compliance — las URLs hoy `*.agentid.example` migran aquí). |

### `crdca.org`

| Subdominio | Uso |
|---|---|
| `c.crdca.org` | CRL Distribution Points (CRL DP) incrustados en cada certificado. |
| `i.crdca.org` | Repositorio de certificados de emisores (intermediate certs) referenciados vía `x5c` / AIA. |

## Por qué `crdca.org` es corto

Las URLs de CRL DP y de emisores **viajan dentro del campo `x5c` / CRL DP de cada certificado X.509 emitido**. Cada byte de esas URLs se copia en:

- cada certificado emitido (miles, con crecimiento perpetuo),
- cada mensaje que los agentes intercambian (el `x5c` viaja en el protocolo entre agentes),
- cada verificación (los verificadores descargan CRLs repetidamente).

Un dominio corto (`crdca.org`, 9 caracteres frente a 10 de `cardca.org` y 10 de `cardca.dev`) y subdominios de una letra (`c.`, `i.`) minimiza el tamaño de cada certificado y de cada intercambio. Es la misma razón por la que los logs de CT clásicos usan dominios cortos (`ct.cloudflare.com`, `o1.log.digicert.com`).

Por eso también la regla de marca: `crdca.org` no se documenta en material público — su única función es aparecer dentro de certificados, donde nadie elige la URL sino la CA al emitir.

## DNS pendiente de configurar

Estado: ningún dominio apunta todavía (pendiente de compra/traslado y de desplegar servicios). Pendientes:

| Registro | Valor previsto | Depende de |
|---|---|---|
| `cardca.org` A/AAAA/CNAME | Hosting del sitio (apex) | Elección de hosting |
| `docs.cardca.org` CNAME | Hosting de docs | — |
| `log.cardca.org` CNAME | Servicio del transparency log | Implementación del log (ver `transparency-log.md`) |
| `status.cardca.org` CNAME | Proveedor de status page | Elección |
| `acme.cardca.dev` A | Servicio `apps/issuer` (CA/ACME prod) | Deploy del issuer con TLS |
| `acme-staging.cardca.dev` A | Issuer staging | — |
| `api.cardca.dev` A | Gateway / API pública (resolver, credit, compliance) | Definición del gateway público |
| `c.crdca.org` A | Servicio que sirve CRLs | Generación de CRLs en el issuer |
| `i.crdca.org` A | Bucket/CDN con certs de emisores | Publicar intermediates |

Notas:

- Los certificados TLS de `acme.cardca.dev` y `acme-staging.cardca.dev` deben emitirse **fuera** de CardCA (otra CA) para evitar auto-dependencia en el arranque.
- Las URLs actuales `https://resolver.agentid.example` / `https://credit.agentid.example` del código se reemplazan por `api.cardca.dev` cuando exista (ver `BRAND.md`, reglas de reemplazo).
- `crdca.org` debe registrarce de forma que no exponga relación pública con la marca salvo por WHOIS interno; no alojar sitio ni docs en él.

## Trabajo pendiente

- [ ] Registrar/trasladar los tres dominios.
- [ ] Crear los registros DNS de la tabla anterior según se despliegan servicios.
- [ ] Emitir TLS para `acme.cardca.dev` con CA externa.
- [ ] Sustituir URLs `*.agentid.example` en código/config por `api.cardca.dev`.
- [ ] Documentar los endpoints ACME en la guía para developers.
