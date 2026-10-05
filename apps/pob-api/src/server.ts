import Fastify, { type FastifyInstance } from 'fastify';
import { computeScore, ephemeralKey, signCredential, verifyReceipt } from './receipts.js';
import { crossAttest } from './cross-attest.js';
import { analyzeCollusion } from './collusion.js';
import { batchRootForDay, splitInterchange, type SettlementRecord } from './settlement.js';
import { openReceiptStore, RECEIPTS_TABLE_DDL, type ReceiptStore } from './store.js';
import { openRecordsStore, RECORDS_TABLE_DDL, type RecordsStore } from './records.js';
import { verifyZkAttestation, type MerklePath } from './zk.js';
import { keccak256, toUtf8Bytes } from 'ethers';
import { registerMetrics } from './metrics.js';
import { applyRateLimit, applyServiceAuth } from './auth.js';

const SERVICE = 'pob-api';

export interface AppDeps {
  receipts: ReceiptStore;
  records: RecordsStore;
}

export async function buildApp(deps?: Partial<AppDeps>): Promise<FastifyInstance> {
  const receipts = deps?.receipts ?? (await openReceiptStore());
  let pool: import('pg').Pool | undefined;
  if (receipts.mode === 'postgres') {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    await pool.query(RECEIPTS_TABLE_DDL);
    await pool.query(RECORDS_TABLE_DDL);
  }
  const records = deps?.records ?? openRecordsStore(pool);
  const counters = { receipts: 0, scores: 0, crossAttests: 0, zkAttests: 0, settles: 0, slashes: 0 };

  const app = Fastify({ logger: false, trustProxy: true });
  const signerAddress = new (await import('ethers')).Wallet(process.env['POB_KEY'] ?? ephemeralKey()).address;
  registerMetrics(app, { service: SERVICE, business: counters, extra: () => ({ lastReceiptSigner: signerAddress, ephemeral: process.env['POB_KEY'] === undefined }) });
  await applyRateLimit(app);
  applyServiceAuth(app);

  app.get('/healthz', async () => ({ ok: true, service: SERVICE, store: receipts.mode, zkRequired: process.env['POB_REQUIRE_ZK'] === 'true' }));

  app.post<{ Body: { receipt?: unknown; signature?: unknown } }>('/receipt', async (req, reply) => {
    const { receipt, signature } = req.body ?? {};
    if (typeof signature !== 'string' || signature.length === 0) {
      return reply.code(400).send({ error: 'signature is required' });
    }
    try {
      const verified = verifyReceipt(receipt, signature);
      const stored = { ...verified.receipt, signer: verified.signer, receivedAt: new Date().toISOString() };
      await receipts.insert(stored);
      counters.receipts += 1;
      return reply.code(201).send({ accepted: true, signer: verified.signer, store: receipts.mode });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid receipt' });
    }
  });

  app.get<{ Params: { agentId: string } }>('/score/:agentId', async (req, reply) => {
    const agentId = req.params.agentId;
    const receiptsList = await receipts.listByAgent(agentId);
    const slashed = await records.isSlashed(agentId);
    if (slashed) {
      counters.scores += 1;
      return { ...computeScore(receiptsList), score: 0, slashed: true };
    }
    if (receiptsList.length === 0) {
      return reply.code(404).send({ error: 'no receipts for agentId' });
    }
    counters.scores += 1;
    return { ...computeScore(receiptsList), slashed: false };
  });

  app.post<{ Params: { agentId: string } }>('/credential/:agentId', async (req, reply) => {
    const receiptsList = await receipts.listByAgent(req.params.agentId);
    const slashed = await records.isSlashed(req.params.agentId);
    const { score } = computeScore(receiptsList);
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const key = process.env['POB_KEY'] ?? ephemeralKey();
    const signature = await signCredential({ agentId: req.params.agentId, score, validUntil }, key);
    const signerAddress = new (await import('ethers')).Wallet(key).address;
    return {
      agentId: req.params.agentId,
      score: slashed ? 0 : score,
      validUntil,
      signature,
      signer: signerAddress,
      ephemeral: process.env['POB_KEY'] === undefined,
    };
  });

  // EP-18 — Atestación cruzada
  app.post<{ Body: { agentId?: unknown } }>('/cross-attest', async (req, reply) => {
    const agentId = req.body?.agentId;
    if (typeof agentId !== 'string' || agentId.length === 0) {
      return reply.code(400).send({ error: 'agentId is required' });
    }
    if (process.env['POB_REQUIRE_ZK'] === 'true' && !(await records.hasValidZkAttestation(agentId))) {
      return reply.code(409).send({
        error: 'zk-required',
        hint: 'submit a valid POST /zk-attest first: a non-expired zk_attest_log entry for this agentId is required',
      });
    }
    const agentReceipts = await receipts.listByAgent(agentId);
    const counterpartyReceipts = (await receipts.listAll()).filter((r) => r.agentId !== agentId);
    const report = crossAttest(agentReceipts, counterpartyReceipts);
    for (const c of report.contradictions) await records.insertContradiction(c);
    counters.crossAttests += 1;
    return { agentId, contradictions: report.contradictions, verdict: report.verdict };
  });

  // EP-19 / Fase 8 — Atestación ZK (privacidad: las contrapartes no se persisten en claro)
  interface ZkCounterpartyBody {
    address?: unknown;
    merklePath?: unknown;
    weak?: unknown;
    weight?: unknown;
  }
  app.post<{ Body: { agentId?: unknown; root?: unknown; minK?: unknown; minWeight?: unknown; counterparties?: ZkCounterpartyBody[] } }>(
    '/zk-attest',
    async (req, reply) => {
      const { agentId, root, minK, minWeight, counterparties } = req.body ?? {};
      if (typeof agentId !== 'string' || agentId.length === 0) {
        return reply.code(400).send({ error: 'agentId is required' });
      }
      if (typeof root !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(root)) {
        return reply.code(400).send({ error: 'root must be a 32-byte hex string' });
      }
      if (typeof minK !== 'number' || !Number.isInteger(minK) || minK < 1) {
        return reply.code(400).send({ error: 'minK must be a positive integer' });
      }
      const minWeightNum = minWeight === undefined ? 0 : minWeight;
      if (typeof minWeightNum !== 'number' || !Number.isInteger(minWeightNum) || minWeightNum < 0) {
        return reply.code(400).send({ error: 'minWeight must be a non-negative integer' });
      }
      if (!Array.isArray(counterparties) || counterparties.length === 0) {
        return reply.code(400).send({ error: 'counterparties must be a non-empty array' });
      }
      const identities: Uint8Array[] = [];
      const paths: MerklePath[] = [];
      const weak: boolean[] = [];
      const weights: number[] = [];
      for (let i = 0; i < counterparties.length; i++) {
        const c = counterparties[i];
        if (typeof c?.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(c.address)) {
          return reply.code(400).send({ error: `counterparties[${i}].address must be a 20-byte hex string` });
        }
        const mp = c.merklePath as { siblings?: unknown; selectors?: unknown } | undefined;
        if (
          !mp ||
          !Array.isArray(mp.siblings) ||
          !mp.siblings.every((s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s)) ||
          !Array.isArray(mp.selectors) ||
          mp.selectors.length !== mp.siblings.length ||
          !mp.selectors.every((s) => typeof s === 'boolean')
        ) {
          return reply.code(400).send({ error: `counterparties[${i}].merklePath must be { siblings: hex32[], selectors: boolean[] } of equal length` });
        }
        if (typeof c.weak !== 'boolean') {
          return reply.code(400).send({ error: `counterparties[${i}].weak must be a boolean` });
        }
        const w = c.weight === undefined ? 100 : c.weight;
        if (typeof w !== 'number' || !Number.isInteger(w) || w < 0) {
          return reply.code(400).send({ error: `counterparties[${i}].weight must be a non-negative integer` });
        }
        identities.push(new Uint8Array(Buffer.from(c.address.slice(2), 'hex')));
        paths.push({
          siblings: (mp.siblings as string[]).map((s) => new Uint8Array(Buffer.from(s.slice(2), 'hex'))),
          selectors: mp.selectors as boolean[],
        });
        weak.push(c.weak);
        weights.push(w);
      }
      const result = verifyZkAttestation({
        root: new Uint8Array(Buffer.from(root.slice(2), 'hex')),
        identities,
        paths,
        weak,
        weights,
        minK,
        minWeight: minWeightNum,
      });
      if (!result.ok) {
        return reply.code(400).send({ error: 'zk-attestation invalid', reason: result.reason });
      }
      const attestationHash = keccak256(
        toUtf8Bytes(
          JSON.stringify({ agentId, root, minK, minWeight: minWeightNum, validAttestations: identities.length, weak }),
        ),
      );
      const record = {
        agentId,
        root,
        minK,
        minWeight: minWeightNum,
        validAttestations: identities.length,
        attestationHash,
        recordedAt: new Date().toISOString(),
      };
      await records.insertZkAttestation(record);
      counters.zkAttests += 1;
      return reply.code(201).send({ accepted: true, attestationHash, root, validAttestations: identities.length });
    },
  );

  // EP-21 — Anti-colusión
  app.get<{ Params: { agentId: string } }>('/colusion/:agentId', async (req, reply) => {
    const agentId = req.params.agentId;
    const [agentReceipts, all] = await Promise.all([receipts.listByAgent(agentId), receipts.listAll()]);
    return analyzeCollusion(agentId, agentReceipts, all);
  });

  // EP-25 — Interchange / settlement
  app.post<{ Body: { gatewayId?: unknown; volumeCreditoWei?: unknown; tier?: unknown } }>('/settle', async (req, reply) => {
    const { gatewayId, volumeCreditoWei, tier } = req.body ?? {};
    if (typeof gatewayId !== 'string' || gatewayId.length === 0) {
      return reply.code(400).send({ error: 'gatewayId is required' });
    }
    if (typeof volumeCreditoWei !== 'string' && typeof volumeCreditoWei !== 'number') {
      return reply.code(400).send({ error: 'volumeCreditoWei is required (string or number)' });
    }
    if (typeof tier !== 'number' || !Number.isInteger(tier)) {
      return reply.code(400).send({ error: 'tier must be an integer between 1 and 5' });
    }
    let volume: bigint;
    try {
      volume = BigInt(volumeCreditoWei);
    } catch {
      return reply.code(400).send({ error: 'volumeCreditoWei must be an integer value' });
    }
    const split = splitInterchange(volume, tier);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const base = {
      gatewayId,
      tier,
      volumeWei: volume.toString(),
      gatewayBps: split.gatewayBps,
      agentidBps: split.agentidBps,
      gatewayAmountWei: split.gatewayAmountWei,
      agentidAmountWei: split.agentidAmountWei,
      day,
      settledAt: now.toISOString(),
    };
    const dayRecords = [...(await records.listSettlementsByDay(day)), base];
    const batchRoot = batchRootForDay(dayRecords);
    const stored: SettlementRecord = { ...base, batchRoot };
    await records.insertSettlement(stored);
    counters.settles += 1;
    return {
      gatewayId,
      gatewayBps: split.gatewayBps,
      agentidBps: split.agentidBps,
      gatewayAmountWei: split.gatewayAmountWei,
      agentidAmountWei: split.agentidAmountWei,
      batchRoot,
    };
  });

  // EP-25/Fase 10A — listado read-only de settlements por día (para el batcher
  // de apps/interchange).
  app.get<{ Params: { day: string } }>('/settlements/:day', async (req, reply) => {
    const day = req.params.day;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return reply.code(400).send({ error: 'day must be YYYY-MM-DD' });
    }
    const list = await records.listSettlementsByDay(day);
    return { day, batchRoot: batchRootForDay(list), settlements: list };
  });

  // EP-28 — Slashing determinístico
  app.post<{ Body: { agentId?: unknown; evidenceHash?: unknown; contradictionType?: unknown } }>(
    '/slash',
    async (req, reply) => {
      const { agentId, evidenceHash, contradictionType } = req.body ?? {};
      if (typeof agentId !== 'string' || agentId.length === 0) {
        return reply.code(400).send({ error: 'agentId is required' });
      }
      if (typeof evidenceHash !== 'string' || evidenceHash.length === 0) {
        return reply.code(400).send({ error: 'evidenceHash is required' });
      }
      const contradiction = await records.getContradiction(evidenceHash);
      if (!contradiction) {
        return reply.code(403).send({ error: 'evidenceHash does not match any registered contradiction' });
      }
      if (contradiction.agentId !== agentId) {
        return reply.code(403).send({ error: 'evidenceHash belongs to a different agent' });
      }
      const record = {
        agentId,
        evidenceHash,
        contradictionType: contradiction.type,
        slashedAt: new Date().toISOString(),
      };
      await records.insertSlash(record);
      counters.slashes += 1;
      return reply.code(201).send({ slashed: true, ...record });
    },
  );

  app.get<{ Params: { agentId: string } }>('/slash/:agentId', async (req) => {
    return { agentId: req.params.agentId, slashes: await records.listSlashes(req.params.agentId) };
  });

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp();
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

if (process.env['NODE_ENV'] !== 'test') {
  main().catch((err) => {
    console.error(JSON.stringify({ level: 'fatal', message: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
