# RFP — Auditoría externa de contratos CardCA (spec v1)

> Fase 9.2 (parte agéntica) · para selección/contratación (gate humano)

## Resumen del proyecto

CardCA es la capa de confianza para agentes de IA (identidad soulbound ERC-721 + atestaciones de capacidades + credencial conductual + cuenta con límites). Los 4 contratos base están implementados y testeados (24 tests Hardhat); el deploy a Base Sepolia está automatizado (gated a fondeo). Contratos ZK-verificadores (UltraHonk) ya generados y probados on-chain en red local.

## Alcance

- `AgentIdRegistry.sol` (166 l.) — soulbound, stake 0.01 ETH, cuotas de flota
- `CertIssuer.sol` (108 l.) — atestaciones EIP-712 con quórum de issuers, vigencia 24 h, anclaje
- `BehaviorProof.sol` (78 l.) — anclaje Merkle de recibos, disputes, slashing determinístico
- `AgentAccountMinimal.sol` (92 l.) — cuenta minimal con límite diario/allowlist (NO ERC-4337)
- (opcional) `BatchVerifier.sol` + `HonkVerifier.sol` (generados por bb) — verificación ZK

## Paquete entregable al auditor

- `audit/scope.md` (superficies de ataque) · `threat-model.md` (activos/actores/amenazas no resueltas) · `test-plan.md` (replicación) · `invariants.md` (7 invariantes formales) · `slither-report.txt` (estático propio) · repo con CI.

## Modalidades y presupuesto (mercado 2026, 4 contratos pequeños/medianos)

| Modalidad | Coste | Duración | Notas |
|---|---|---|---|
| Tier 1 (Trail of Bits, OpenZeppelin, Spearbit) | 50–150k USD | 4–8 semanas | Solo si un partner del consorcio lo exige |
| Contest público (Cantina / Code4rena / Sherlock) | 20–50k USD prize pool | 1–3 semanas | Varios ojos, fijo por plazo; **recomendación inicial** |
| Boutique (Ackee, Trust Security, Fuzzing Labs) | 15–40k USD | 1–2 semanas | Buen equilibrio precio/profundidad |

Presupuesto de referencia del proyecto: ronda seed $6.5M (blueprint 05) — el contest boutique es coherente con el día-90 gate.

## Cronograma

- Contratación: semanas 6–8 desde el MVP (ya corridas las fases 0–8 agénticas).
- Informe esperado antes del día 90 (gate del roadmap).
- Después del deploy en Base Sepolia (automatizado con fondeo) para que el bytecode auditado sea el desplegado.

## Entregables exigidos

1. Informe con severidades (Info/Low/Med/High/Crit) + PoC reproducible.
2. Revisión de los 7 invariantes (`audit/invariants.md`) — explícito: cuál confirma, cuál refuta.
3. Confirmación del modelo de amenazas o correcciones al mismo.
4. (Si hay hallazgos) interacción con el equipo para remediación + informe final.

## Criterios de selección

- Experiencia verificable en ERC-721/ERC-4337/soulbound o slashing disputes.
- Metodología con invariantes/fuzzing (Foundry/Echidna/Medusa) además de manual.
- Ventana de remediation incluida en el precio.
