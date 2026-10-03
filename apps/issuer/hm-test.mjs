import Fastify from 'fastify';
import crypto from 'node:crypto';
import { requireHmac } from '@agentid/sdk-auth';

const secret = 'local-secret';
const app = Fastify();
app.addHook('preParsing', (req, _r, payload, done) => {
  const chunks = [];
  payload.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  payload.on('end', () => { req.rawBody = Buffer.concat(chunks); done(null, payload); });
});
app.post('/attestation', { preHandler: requireHmac({ secrets: { e2e: secret } }) }, async () => ({ ok: true }));
await app.listen({ port: 4378 });

const BODY = '{"agentId":"smoke-1"}';
const bodySha = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
const msg = ['POST', '/attestation', bodySha].join('\n');
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(msg).digest('hex');
const res = await fetch('http://127.0.0.1:4378/attestation', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-service-id': 'e2e', 'x-timestamp': String(Date.now()), 'x-signature': sig },
  body: BODY,
});
console.log('fetch test →', res.status, await res.text());
process.exit(0);
