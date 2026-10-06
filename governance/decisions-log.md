# Decisiones — Consorcio CardCA

> Registro de decisiones del consorcio (RFCs, admisiones, rotaciones). A partir de la firma del acta (gate humano), este fichero es apéndice del acta y solo puede crecer.

| Fecha | Decisión | Procedencia | Estado |
|---|---|---|---|
| 2026-10-04 | Steward inicial: Nexgen Systems; spec v1 congela formatos EIP-712 de recibo y score | blueprint 03/07 + Fase 9.4 | propuesto (RFC-001 abierto) |
| 2026-10-04 | Auditoría externa: modalidad boutique/contest (RFP en audit/rfp.md); tier 1 solo si un partner lo exige | Fase 9.2 | propuesto |
| 2026-10-04 | Deploy a Base Sepolia automatizado gated a fondeo (workflow anchor-real.yml) | Fase 7-R | activo |
| 2026-10-04 | NATS del blueprint sustituido por cola-Postgres + HTTP interno (topología real) | Fase 7 / A4 ítem 10 | decidido (documentado en EP-13) |
| 2026-10-04 | AgentAccountMinimal NO es 4337 completo; el 4337 real (EP-23) queda para producción con bundler/paymaster | Fase 5.2 | decidido |
| 2026-10-06 | Rebranding del proyecto: AGENT.ID → **CardCA** (marca pública y forma técnica `cardca`; scope npm `@agentid/` → `@cardca/`; dominios oficiales: `cardca.org` marca/docs/CP-CPS, `cardca.dev` desarrolladores incl. `acme.cardca.dev`/`acme-staging.cardca.dev`/`api.cardca.dev`, `crdca.org` solo URLs incrustadas en certificados — `c.crdca.org` CRLs, `i.crdca.org` certs de emisores). Mapa de reemplazos y excepciones en `BRAND.md`. Variables de entorno de marca pasan a `CARDCA_*` con fallback a `AGENTID_*` durante la transición. | Rebranding 2026-10-06 | decidido |
