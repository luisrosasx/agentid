# Response Plan — plantilla por hallazgo de auditoría

> Fase 9.2 · completar una fila por cada hallazgo del informe externo y commitear con el informe final

| ID | Severidad | Hallazgo (resumen) | Componente | Decisión (fix/wontfix/pospuesto) | Fix (commit/PR) | Verificación post-fix |
|---|---|---|---|---|---|---|
| F-001 | High | (ejemplo) falta validación en anchorRoot | CertIssuer | fix | PR # | hardhat test + e2e |
| F-002 | Info | (ejemplo) nombre de evento | Registry | wontfix | — | — |

## Reglas de triage (agénticas, cuando llegue el informe)

1. **Crit/High** → fix obligatorio ANTES de cualquier deploy con valor real; re-deploy testnet + re-verificación; EP-09 se re-abre honestamente si toca.
2. **Medium** → fix en el mismo release si el coste < 1 día-agéntico; si no, a backlog con etiqueta `audit-finding`.
3. **Low/Info** → decisión documentada en la tabla; "wontfix" exige una línea de justificación.
4. Todo fix pasa CI completa + e2e antes de merge; los contratos re-desplegados invalidan las addresses de `deployments.json` → el workflow `anchor-real.yml` re-despliega en el próximo run.
