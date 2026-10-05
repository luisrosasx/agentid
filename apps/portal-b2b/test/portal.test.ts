import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFleet, PRICE_BOOK, renderHtml } from '../src/portal.js';

test('loadFleet with default data source is fail-closed: empty without backends', async () => {
  const fleet = await loadFleet(undefined, undefined);
  assert.deepEqual(fleet, []);
});

test('loadFleet stays empty when the configured endpoint is unreachable (live)', async () => {
  const fleet = await loadFleet('http://127.0.0.1:1', undefined, 'live');
  assert.deepEqual(fleet, []);
});

test('sample data only appears when explicitly requested', async () => {
  const fleet = await loadFleet(undefined, undefined, 'sample');
  assert.ok(fleet.length > 0);
  assert.ok(fleet.every((i) => i.source === 'sample'));
});

test('price book has the four tiers with the agreed prices', () => {
  assert.deepEqual(
    PRICE_BOOK.map((p) => p.priceUsd),
    [0, 12, 50, 180],
  );
  const enterprise = PRICE_BOOK[3];
  assert.ok(enterprise.note.includes('$180'));
});

test('renderHtml escapes agent ids and includes both tables', () => {
  const html = renderHtml([{ agentId: '<script>x</script>', source: 'sample', score: 10, status: 'active' }]);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Price book'));
  assert.ok(html.includes('$180/mes'));
});

test('renderHtml shows the empty-state row for an empty fleet', () => {
  const html = renderHtml([]);
  assert.ok(html.includes('backend unreachable'));
  assert.ok(!html.includes('agent-demo'));
});
