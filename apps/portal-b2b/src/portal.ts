export interface FleetIdentity {
  agentId: string;
  source: 'pob' | 'resolver' | 'sample';
  score: number | null;
  status: string;
}

export const PRICE_BOOK = [
  { tier: 'Starter', agents: 1, priceUsd: 0, note: '1 agente, score PoB público' },
  { tier: 'Team', agents: 5, priceUsd: 12, note: '5 agentes, credenciales PoB firmadas' },
  { tier: 'Business', agents: 25, priceUsd: 50, note: '25 agentes, Cuenta Agentil + API crédito' },
  { tier: 'Enterprise', agents: null, priceUsd: 180, note: 'agentes ilimitados, ancla año 2 $180, SLA' },
] as const;

const SAMPLE_FLEET: FleetIdentity[] = [
  { agentId: 'agent-demo-001', source: 'sample', score: 62, status: 'active' },
  { agentId: 'agent-demo-002', source: 'sample', score: 41, status: 'active' },
  { agentId: 'agent-demo-003', source: 'sample', score: 88, status: 'active' },
];

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeIdentities(raw: unknown, source: 'pob' | 'resolver'): FleetIdentity[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      agentId: typeof x['agentId'] === 'string' ? x['agentId'] : String(x['agentId'] ?? ''),
      source,
      score: typeof x['score'] === 'number' ? x['score'] : null,
      status: typeof x['status'] === 'string' ? x['status'] : 'unknown',
    }))
    .filter((x) => x.agentId.length > 0);
}

export async function loadFleet(pobUrl: string | undefined, resolverUrl: string | undefined): Promise<FleetIdentity[]> {
  if (pobUrl) {
    const raw = await fetchJson(`${pobUrl.replace(/\/$/, '')}/fleet`);
    const fromPob = normalizeIdentities(raw, 'pob');
    if (fromPob.length > 0) return fromPob;
  }
  if (resolverUrl) {
    const raw = await fetchJson(`${resolverUrl.replace(/\/$/, '')}/fleet`);
    const fromResolver = normalizeIdentities(raw, 'resolver');
    if (fromResolver.length > 0) return fromResolver;
  }
  return SAMPLE_FLEET;
}

export function renderHtml(identities: FleetIdentity[]): string {
  const rows = identities
    .map(
      (i) =>
        `<tr><td>${escapeHtml(i.agentId)}</td><td>${escapeHtml(i.source)}</td>` +
        `<td>${i.score === null ? '—' : i.score}</td><td>${escapeHtml(i.status)}</td></tr>`,
    )
    .join('\n');
  const priceRows = PRICE_BOOK.map(
    (p) =>
      `<tr><td>${p.tier}</td><td>${p.agents === null ? 'Ilimitados' : p.agents}</td>` +
      `<td>$${p.priceUsd}/mes</td><td>${escapeHtml(p.note)}</td></tr>`,
  ).join('\n');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>AGENT.ID — Portal B2B</title>
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
<h1>AGENT.ID — Dashboard B2B</h1>
<p class="muted">Identidades agénticas registradas</p>
<table>
<thead><tr><th>agentId</th><th>fuente</th><th>score PoB</th><th>estado</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<h2>Price book</h2>
<table>
<thead><tr><th>Plan</th><th>Agentes</th><th>Precio</th><th>Incluye</th></tr></thead>
<tbody>
${priceRows}
</tbody>
</table>
<p class="muted">Ancla de renovación año 2: $180/mes en todos los planes de pago.</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
