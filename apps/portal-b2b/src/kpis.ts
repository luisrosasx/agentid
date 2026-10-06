import type { FleetIdentity } from './portal.js';

/**
 * Dashboard de KPIs (Fase 10B), según el dashboard único de adopción del
 * blueprint 06 §6 y las señales de validación del día 90 del blueprint 04.
 *
 * La métrica reina es "servicios que exigen AGENT.CERT en checks de
 * permisos" (06 §6). Los KPIs de negocio que el portal aún no instrumenta
 * (facturación, interchange, atestaciones/día) se reportan como
 * `available: false` con valor null — nunca se inventan cifras.
 */

export interface KpiInput {
  fleet: FleetIdentity[];
  requestsTotal: number;
  fleetQueries: number;
  p99Ms: number;
  uptimeS: number;
  /** Nº de servicios que exigen la cert en checks de permisos (integral externa). */
  certEnforcingServices?: number;
  /** Atestaciones emitidas/día (integral del emisor). */
  attestationsPerDay?: number;
  /** % de renovación de vigencia (integral del emisor). */
  renewalRatePct?: number;
  /** % de interacciones A2A con recibo bilateral (integral del interchange). */
  receiptCoveragePct?: number;
  /** Flotas corporativas pagando (facturación). */
  payingFleets?: number;
  /** ARR en USD (facturación). */
  arrUsd?: number;
}

export interface KpiRow {
  kpi: string;
  value: number | null;
  unit: string;
  target: string;
  source: string;
  available: boolean;
}

export interface KpiDashboard {
  queen: KpiRow;
  kpis: KpiRow[];
  generatedAt: string;
}

const NA = '—';

function row(
  kpi: string,
  value: number | null,
  unit: string,
  target: string,
  source: string,
): KpiRow {
  return { kpi, value, unit, target, source, available: value !== null && Number.isFinite(value) };
}

function fmtValue(r: KpiRow): string {
  if (!r.available) return NA;
  if (r.unit === '%') return `${r.value}%`;
  return String(r.value);
}

export function computeKpis(input: KpiInput): KpiDashboard {
  const fleet = input.fleet;
  const activeAgents = fleet.filter((i) => i.status === 'active').length;
  const scored = fleet.filter((i) => i.score !== null);
  const avgScore = scored.length > 0 ? scored.reduce((s, i) => s + (i.score ?? 0), 0) / scored.length : null;

  const queen = row(
    'Servicios que exigen AGENT.CERT (métrica reina)',
    input.certEnforcingServices ?? null,
    '',
    '≥3 (fase 1) · ≥25 (fase 2) · ≥100 (fase 3)',
    'integral externa (blueprint 06 §6)',
  );

  return {
    queen,
    kpis: [
      queen,
      row('Agentes identificados en flota', fleet.length, '', '—', 'fleet (pob/resolver)'),
      row('Agentes activos en flota', activeAgents, '', '—', 'fleet (pob/resolver)'),
      row('Score PoB promedio', avgScore === null ? null : Math.round(avgScore * 10) / 10, '', '—', 'fleet (pob/resolver)'),
      row('Latencia p99 verificación (portal)', input.p99Ms, 'ms', '<10 ms verde (blueprint 04)', 'módulo metrics'),
      row('Requests totales al portal', input.requestsTotal, '', '—', 'módulo metrics'),
      row('Consultas de flota', input.fleetQueries, '', '—', 'contador business'),
      row('Atestaciones emitidas/día', input.attestationsPerDay ?? null, '', '10k (f1) · 200k (f2) · 1M (f3)', 'integral del emisor'),
      row('Retención de vigencia (renovación)', input.renewalRatePct ?? null, '%', '≥70% (f1) · ≥80% (f2) · ≥85% (f3)', 'integral del emisor'),
      row('Recibos bilaterales / interacción A2A', input.receiptCoveragePct ?? null, '%', '≥40% (f2) · ≥60% (f3)', 'integral del interchange'),
      row('Flotas corporativas pagando', input.payingFleets ?? null, '', '≥10 (f2) · ≥100 (f3)', 'facturación'),
      row('ARR', input.arrUsd ?? null, 'USD', '≥$1M (f2) · ≥$8M (f3)', 'facturación'),
    ],
    generatedAt: new Date().toISOString(),
  };
}

export function renderKpisHtml(d: KpiDashboard): string {
  const all = d.kpis;
  const rows = all
    .map(
      (k) =>
        `<tr><td>${escapeHtml(k.kpi)}</td><td>${escapeHtml(fmtValue(k))}</td>` +
        `<td>${escapeHtml(k.unit || '—')}</td><td>${escapeHtml(k.target)}</td>` +
        `<td>${escapeHtml(k.source)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>CardCA — KPIs</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #111; }
  h1 { font-size: 1.4rem; }
  table { border-collapse: collapse; margin-bottom: 2rem; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.8rem; text-align: left; }
  th { background: #f4f4f4; }
  .muted { color: #666; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>CardCA — Dashboard de KPIs</h1>
<p class="muted">Dashboard único de adopción (blueprint 06 §6) y señales del día 90 (blueprint 04). Los KPIs sin instrumentación aún se muestran como —, nunca se inventan cifras.</p>
<table>
<thead><tr><th>KPI</th><th>Valor</th><th>Unidad</th><th>Objetivo</th><th>Fuente</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="muted">Generado: ${escapeHtml(d.generatedAt)}</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
