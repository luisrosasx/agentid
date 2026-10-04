# RFC-001 (borrador) — Formato de recibo bilateral y score PoB v1

> Fase 9.4 · primer RFC real: congela el formato EIP-712 de recibos y el cálculo del score, extraído de blueprint 03 §4 y 07 §2 y de la implementación actual (`packages/sdk-receipts`, `apps/pob-api`)

## Resumen

Congelar para la spec v1: (a) el dominio y tipos EIP-712 del recibo bilateral,
(b) los mecanismos anti-colusión, (c) el rango y semántica del score pre-transaccional.

## Formato de recibo (EIP-712)

```
Domain:  name "AGENT.ID Proof-of-Behavior", version "1", chainId <red>, verifyingContract <BehaviorProof address>
Types:   Receipt(agentId, counterparty (address), outcome, nonce, issuedAt, counterpartyStakeRoot)
Signer:  la clave POB del emisor (verificable en BehaviorProof/metrics lastReceiptSigner)
```

- `outcome` ∈ {success, fail, dispute} — valores cerrados.
- `nonce` único por par (agente, contraparte) — defensa anti-farm testada (granja 400/400 detectada).
- `counterpartyStakeRoot` — compromiso del stake de la contraparte (≥0.01 ETH según blueprint 03 §6; ponderación de débiles ≤10% implementada en el circuito ZK).

## Score

- Rango **[0.00, 1.00]**, único número canónico por agente y ventana.
- Entradas: recibos verificados (firma + no expirados), penalizaciones de slashing (score 0 en corte) y límites de concentración (top-1 >50% → riesgo high; HHI ≥0.5 → low).
- Consumo: la Cuenta Agentil mapea score → límite diario (score 42/100 → 0.42 ETH/día en el e2e en vivo).
- **Pre-transaccional**: el gateway consulta el score antes de permitir la acción (latencia objetivo <1 ms, cacheo documentado).

## Anti-colusión (resumen normativo)

1. Reciprocidad ciclos (grafo dirigido de recibos).
2. Concentración top-1 >50% → high.
3. HHI sobre distribución de contrapartes.
4. (Fase 8) Pertenencia ZK: prueba `distinctCounterparties(min_k, min_weight)` con árbol Merkle keccak — identidades privadas; agregación por sub-lotes ≤128 con verificación en lote on-chain (`BatchVerifier`).

## Impacto en compatibilidad

- Cambiar cualquier campo EIP-712 = v2 (semver del domain).
- Los recibos emitidos con v1 permanecen verificables (chainId + verifyingContract fijos).

## Estado

| Fecha | Evento |
|---|---|
| 2026-10-04 | Borrador abierto a comentarios (14 días) |
| — | Gate: acta del consorcio (humano) para declararlo "Accepted" |
