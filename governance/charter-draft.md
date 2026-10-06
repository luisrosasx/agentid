# Charter del Consorcio CardCA (borrador v0.1)

> Fase 9.4 · **borrador** — el acta firmada es el gate humano (EP-29); este doc es la base de negociación

## 1. Propósito

Gestionar la **spec v1 de CardCA** como estándar abierto del "internet agentil":
identidad agéntica verificable (Agent Card), conducta probada (Proof-of-Behavior) y
cuentas con límites (Cuenta Agentil), interoperable con el Protocolo A2A.

## 2. Miembros y roles

| Rol | Quiénes (inicial) | Responsabilidad |
|---|---|---|
| **Steward** (host) | Nexgen Systems | Mantener spec, CI, despliegues de referencia; custodio de repo y toolchain |
| **Issuers** (3–5) | Fondos/pannéis de KYC licenciados (por designar) | Firmar atestaciones CERT; rotación de claves por quórum |
| **Slasher** | Entidad de disputes (por designar) | Ejecutar slashing determinístico con evidencia vinculante |
| **Plataformas piloto** (≥3) | Gateways/aggregators (por reclutar) | Adopción del gateway, feedback de la spec vía RFCs |
| **Auditor** | Firma externa (RFP en `audit/rfp.md`) | Auditoría de contratos + revisión de invariantes |

## 3. Procesos

- **RFCs**: cualquier cambio de la spec abre un RFC (plantilla en `rfc-template.md`);
  periodo de comentarios 14 días; decisión por quórum simple de miembros activos con
  registro en `decisions-log.md`.
- **Rotación de claves de issuer/slasher**: exige quórum 3-de-5 documentado; los
  eventos on-chain (`AgentMinted`, `Slashed`, …) son la evidencia.
- **Versionado de la spec**: semver; v1 congela los formatos de recibo (EIP-712) y
  score; cambios incompatibles = v2 con migración documentada.
- **Gates del roadmap**: día-90 = consorcio activo + informe de auditoría recibido;
  pilotos (≥3 plataformas) = gate de comercialización.

## 4. Licencias

- Spec y RFCs: **CC BY 4.0** (atribución, cambios documentados).
- Código de referencia (monorepo): **Apache-2.0** (alineado con los headers SPDX ya presentes).
- Marca CardCA / Agent Card: del steward; uso libre para implementaciones conformes.

## 5. Admisión y salida

- Admisión: 2 firmas de miembros activos; los issuers necesitan licencia KYC verificable.
- Salida: notificación 30 días; los miembros salientes dejan de contar en quórum en
  el cierre del ciclo de RFC en curso.
