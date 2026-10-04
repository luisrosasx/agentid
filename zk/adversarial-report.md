# EP-19-S5 — Reporte adversarial

> 2026-10-04T08:56:36.880Z · circuito `dc_subbatch` (n_active=4, árbol 1024, 10 niveles) · casos deterministas

| Clase | Casos | Rechazados |
|---|---|---|
| caseWindow | 2000 | 2000 |
| caseDup | 2000 | 2000 |
| caseWeakWeight | 2000 | 2000 |
| caseBadProof | 2000 | 2000 |
| caseTooFewK | 2000 | 2000 |

**TOTAL: 10000/10000 rechazados · pruebas falsas aceptadas: 0 · validación del espejo contra el circuito real (nargo execute): 0 mismatches en 0 ejecuciones**

Metodología: espejo TS con el MISMO orden de restricciones (ventana → unicidad pairwise → pertenencia Merkle keccak → min_k/min_weight), validado con muestra real de ejecuciones del circuito Noir. ✅ 0 pruebas falsas aceptadas.
