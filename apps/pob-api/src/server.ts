import Fastify from 'fastify';
import { computeScore, ephemeralKey, signCredential, verifyReceipt } from './receipts.js';
import { openReceiptStore, RECEIPTS_TABLE_DDL, type ReceiptStore } from './store.js';

const SERVICE = 'pob-api';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  const store: ReceiptStore = await openReceiptStore();

  if (store.mode === 'postgres') {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    await pool.query(RECEIPTS_TABLE_DDL);
    await pool.end();
  }

  app.get('/healthz', async () => ({ ok: true, service: SERVICE, store: store.mode }));

  app.post<{ Body: { receipt?: unknown; signature?: unknown } }>('/receipt', async (req, reply) => {
    const { receipt, signature } = req.body ?? {};
    if (typeof signature !== 'string' || signature.length === 0) {
      return reply.code(400).send({ error: 'signature is required' });
    }
    try {
      const verified = verifyReceipt(receipt, signature);
      const stored = { ...verified.receipt, signer: verified.signer, receivedAt: new Date().toISOString() };
      await store.insert(stored);
      return reply.code(201).send({ accepted: true, signer: verified.signer, store: store.mode });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid receipt' });
    }
  });

  app.get<{ Params: { agentId: string } }>('/score/:agentId', async (req, reply) => {
    const receipts = await store.listByAgent(req.params.agentId);
    if (receipts.length === 0) {
      return reply.code(404).send({ error: 'no receipts for agentId' });
    }
    return computeScore(receipts);
  });

  app.post<{ Params: { agentId: string } }>('/credential/:agentId', async (req, reply) => {
    const receipts = await store.listByAgent(req.params.agentId);
    const { score } = computeScore(receipts);
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const key = process.env['POB_KEY'] ?? ephemeralKey();
    const signature = await signCredential({ agentId: req.params.agentId, score, validUntil }, key);
    const signerAddress = new (await import('ethers')).Wallet(key).address;
    return {
      agentId: req.params.agentId,
      score,
      validUntil,
      signature,
      signer: signerAddress,
      ephemeral: process.env['POB_KEY'] === undefined,
    };
  });

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', message: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
