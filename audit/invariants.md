# Invariantes formales — CardCA (contratos v1)

> Fase 9.1 · invariantes que el auditor debe verificar formalmente (fuzzing/invariant tests de nuevo desarrollo + los implícitos en la suite actual)

## I1 — Soulbound imposible

`AgentIdRegistry`: ningún par de llamadas (por ningún actor, incluido owner/registrar)
transfiere un agentId de un owner a otro. Incluye `transferFrom`, `safeTransferFrom`
(2 sobrecargas), `approve`+transfer chains y `safeTransferFrom` con datos.

**Verificación actual:** 3 rutas testeadas (revert). **Pendiente para auditoría:**
invariant fuzzing con ERC-721 hooks (`supportsInterface`) y interfaces de mercado.

## I2 — Quórum no evadible

`CertIssuer.issueAttestation` solo acepta el digest firmado por el panel de issuers
registrado en el constructor; ningún digest reusado entre (agentId, certType,
capabilitiesHash, expiresAt) distintos puede validar, y una atestación nunca sobrevive
a su `expiresAt` (vigencia 24 h, `isValid`).

## I3 — Slashing determinístico

`BehaviorProof.slash(agentId)`: solo `slasher`; sin parámetros discrecionales; un
agentId sin atestación/stake no puede ser slashado a un estado inconsistente
(balance ↔ score coherente con el registro).

## I4 — Anclaje idempotente y autoral

`CertIssuer.anchorRoot` / `BehaviorProof.anchorReceipts`: un root solo puede anclarlo
el anclador autorizado; reanclar el MISMO root es inofensivo (evento igual); reanclar
un root DISTINTO para el mismo agentId/lote debe ser imposible o trazable (evento
`ReceiptsAnchored`/`RootAnchored` con hash del lote).

## I5 — Stake conservado

`AgentIdRegistry`: la suma de stake acumulado solo decrece por `burnStake` legítimo
(called por quien corresponde) y cada `mint` suma exactamente `msg.value`;
`burnStake` nunca deja saldo negativo ni paga a quien no es el dueño del stake.

## I6 — Límite diario inviolable (AgentAccountMinimal)

Ninguna secuencia de `execute` dentro de un día gasta más que `dailyLimitWei`;
el rolado de día (`_rollDay`) resetea `spentToday` exactamente al cambiar el día UTC;
targets fuera de la allowlist nunca ejecutan.

## I7 — Verificador ZK completo y adosado al VK

`HonkVerifier(.sol)`/`HonkVerifierSubbatch.sol`: aceptan SOLO pruebas generadas para
el VK embedded (`vk_hash`); una prueba para otro circuito o con public inputs
reordenadas NO verifica. El número/orden de public inputs (36 en v2, 20 en subbatch
— raíz byte-por-campo + escalares) coincide con el ABI Noir.
