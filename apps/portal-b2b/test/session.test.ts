import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, sessionCookie, readSessionCookie } from '../src/session.js';

test('signSession + verifySession round-trip with valid token', () => {
  const secret = 'test-secret';
  const token = signSession(secret, 'op', 60_000);
  const payload = verifySession(secret, token);
  assert.ok(payload);
  assert.equal(payload.u, 'op');
  assert.ok(payload.exp > Date.now());
});

test('verifySession rejects tampered token', () => {
  const token = signSession('test-secret', 'op', 60_000);
  assert.equal(verifySession('other-secret', token), null);
  assert.equal(verifySession('test-secret', token.slice(0, -2) + 'zz'), null);
});

test('verifySession rejects expired token', () => {
  const token = signSession('test-secret', 'op', -1000);
  assert.equal(verifySession('test-secret', token), null);
});

test('session cookie is HttpOnly, SameSite=Strict and parseable', () => {
  const cookie = sessionCookie('tok.ens', 8 * 3600 * 1000);
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Strict'));
  assert.ok(cookie.includes('Max-Age=28800'));
  const fakeReq = { headers: { cookie: `a=1; ${cookie.split(';')[0]}` } } as never;
  assert.equal(readSessionCookie(fakeReq), 'tok.ens');
});
