import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, sha256 } from '../src/main.ts';

test('healthz', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, service: 'challenges' });
});

test('challenge lifecycle', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/challenge',
    payload: { agentId: 'agent-1' },
  });
  assert.equal(created.statusCode, 201);
  const { id, prompt, nonce } = created.json();
  assert.ok(id && prompt && nonce);

  const status = await app.inject({ method: 'GET', url: `/challenge/${id}` });
  assert.equal(status.json().passed, false);

  const wrong = await app.inject({
    method: 'POST',
    url: `/challenge/${id}/answer`,
    payload: { answer: 'nope' },
  });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().passed, false);

  const good = await app.inject({
    method: 'POST',
    url: `/challenge/${id}/answer`,
    payload: { answer: nonce },
  });
  assert.equal(good.statusCode, 200);
  const body = good.json();
  assert.equal(body.passed, true);
  const answerHash = sha256(`${prompt}:${nonce}`);
  assert.equal(body.proofHash, sha256(`${id}:${answerHash}:${answerHash}`));
});

test('missing agentId rejected', async () => {
  const res = await app.inject({ method: 'POST', url: '/challenge', payload: {} });
  assert.equal(res.statusCode, 400);
});
