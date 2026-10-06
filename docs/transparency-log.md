# CardCA — Diseño del Log de Transparencia

> Estado: diseño (borrador v1). No implementado todavía.
> Dominio previsto: `cardca.org` (ver `BRAND.md` — Dominios).

## Propósito

CardCA es una Autoridad Certificadora (CA) pública de Agent Cards: emite certificados X.509 (`x5c`) vía ACME, ancla la identidad on-chain en Base Sepolia y acredita comportamiento con Proof-of-Behavior. Como toda CA pública, debe ofrecer un **log de transparencia** (estilo Certificate Transparency) que haga pública y auditable cada certificado emitido, de modo que:

- Un emisor o titular pueda comprobar que CardCA **no emite certificados de más** (emisiones fantasma para un `agent_id` que no solicitó nada).
- Un verificador pueda exigir la prueba de inclusión (`SCT` / inclusion proof) antes de aceptar un Agent Card.
- Auditores (ver `audit/` y `governance/`) puedan reconstruir el histórico completo de emisiones.

## Esquema de entradas

Cada entrada del log representa un **certificado emitido** (no una solicitud). Propuesta de esquema JSON canónico (se firma el hash canónico, no el JSON en sí):

```json
{
  "v": 1,
  "leaf_index": 4821,
  "timestamp": "2026-08-14T10:22:31Z",
  "log_id": "cardca-log-2026",
  "entry_type": "agent_card",
  "cert_sha256": "<sha256 del DER del certificado emitido>",
  "issuer_cn": "CardCA Issuer 2026",
  "subject": {
    "agent_id": "<identificador del agente>",
    "agent_pubkey_sha256": "<sha256 de la clave pública del agente>"
  },
  "chain_anchor": {
    "network": "base-sepolia",
    "registry_tx": "<tx del anchor en el registry>"
  },
  "tree": {
    "size": 4821,
    "root_hash": "<raíz del árbol Merkle tras incluir esta entrada>"
  }
}
```

Notas de diseño:

- **`cert_sha256`** es el ancla de la entrada: permite verificar que la entrada corresponde exactamente a un certificado real sin publicar el DER completo (opción: servir el DER en un bucket asociado bajo `i.crdca.org`).
- **`agent_pubkey_sha256`** (no la clave completa) evita correlacionar entradas con claves si el agente rota; el hash es suficiente para auditoría de duplicados.
- **`chain_anchor`** enlaza la emisión con el anclaje on-chain en Base Sepolia; una entrada sin anchor válido queda marcada `pending_anchor` hasta que el registry confirme.
- `entry_type` admite extensiones futuras (`crl`, `revocation`) para logear también CRLs emitidas.

## Inclusión de entradas

1. Durante la emisión ACME, el issuer genera el certificado y calcula `cert_sha256`.
2. El issuer **debe** enviar la entrada al log **antes de devolver el certificado** al agente (misma disciplina que los SCT de CT clásico). Si el log no está disponible, la emisión falla cerrada (fail-closed): CardCA no emite certificados no logeados.
3. El log responde con un **Signed Certificate Timestamp (SCT)**: `log_id`, `timestamp`, `leaf_index`, firma del log sobre la entrada.
4. El SCT se incrusta en la extensión X.509 del certificado (OID reservado para CardCA) y se devuelve también en la respuesta ACME.
5. Escrituras del log son **append-only**: solo el servicio del log (bajo `cardca.org`) añade hojas; el árbol Merkle se recomputa y se publica una nueva raíz firmada (STH) a intervalos regulares (objetivo: cada 5 minutos o cada N entradas).

## Verificación

Un verificador que recibe un Agent Card puede hacer tres comprobaciones:

1. **SCT válido** — la firma del log sobre la entrada verificada contra la clave pública del log (publicada y rotada bajo `cardca.org`, pinneada en el código del verificador y en `packages/`).
2. **Prueba de inclusión** — con `leaf_index`, `cert_sha256` y la raíz actual (`STH`), el verificador pide una inclusion proof Merkle y la valida localmente. Algoritmo: árbol Merkle RFC 6962 (SHA-256, hojas con prefijo `0x00`).
3. **Concordancia** — el `cert_sha256` de la entrada coincide con el DER del certificado recibido vía `x5c`, y `chain_anchor.registry_tx` coincide con el anclaje leído del registry en Base Sepolia.

Un verificador puede además hacer **consistencia de árbol** (audit proof entre dos STHs) para comprobar que el log nunca reescribe el pasado — la garantía de append-only.

## Hosting

- **Servicio:** API HTTP del log servida bajo `https://log.cardca.org` (subdominio nuevo a configurar; ver `docs/domains.md`).
- **Endpoints previstos:**
  - `GET /v1/sth` — raíz firmada actual (STH).
  - `GET /v1/entries?start=&end=` — entradas crudas por rango.
  - `GET /v1/proof/inclusion?leaf_index=&tree_size=` — prueba de inclusión.
  - `GET /v1/proof/consistency?first=&second=` — prueba de consistencia entre árboles.
  - `GET /v1/keys` — claves públicas del log y su rotación.
- **Integridad del almacenamiento:** el log completo se exporta periódicamente (snapshot + STH firmados) a un medio externo (bucket / repo de governance) para que la CA no pueda borrar silenciosamente entradas.
- **Nota sobre dominios:** el log es documentación/infraestructura pública → vive en `cardca.org`, **no** en `crdca.org`, que queda reservado solo para URLs incrustadas dentro de certificados (`c.crdca.org` CRLs, `i.crdca.org` certs de emisores).

## Trabajo pendiente

- [ ] Fijar el OID de la extensión SCT de CardCA.
- [ ] Definir formato exacto del STH (TBS + firma) y su versionado.
- [ ] Elegir mecanismo append-only del backend (log firmado + exportación, o Merkle tree on-service).
- [ ] Configurar DNS de `log.cardca.org` y desplegar el servicio.
- [ ] Integrar la llamada al log en el flujo de emisión del issuer (fail-closed).
- [ ] Añadir verificación de SCT/inclusión en los verificadores del monorepo (`packages/`, `e2e/`).
