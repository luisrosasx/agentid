import Fastify from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { registerMetrics } from './metrics.js';
import { applyRateLimit, applyServiceAuth } from './auth.js';

const CHALLENGE_TTL_SECONDS = 300;

interface Challenge {
  id: string;
  agentId: string;
  prompt: string;
  nonce: string;
  expectedAnswerHash: string;
  createdAt: number;
  expiresAt: number;
  passed: boolean;
  proofHash: string | null;
}

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

const memory = new Map<string, Challenge>();

let pool: PgPool | null = null;
if (process.env.DATABASE_URL) {
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  pool = {
    query: (sql, params) => pg.query(sql, params as never),
  };
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function ensureTable(): Promise<void> {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expected_answer_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      passed BOOLEAN NOT NULL DEFAULT FALSE,
      proof_hash TEXT
    )
  `);
}

async function saveChallenge(c: Challenge): Promise<void> {
  memory.set(c.id, c);
  if (!pool) return;
  await pool.query(
    `INSERT INTO challenges (id, agent_id, prompt, nonce, expected_answer_hash, created_at, expires_at, passed, proof_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET passed = EXCLUDED.passed, proof_hash = EXCLUDED.proof_hash`,
    [c.id, c.agentId, c.prompt, c.nonce, c.expectedAnswerHash, new Date(c.createdAt), new Date(c.expiresAt), c.passed, c.proofHash],
  );
}

async function loadChallenge(id: string): Promise<Challenge | null> {
  const mem = memory.get(id);
  if (mem) return mem;
  if (!pool) return null;
  const res = await pool.query('SELECT * FROM challenges WHERE id = $1', [id]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    prompt: String(row.prompt),
    nonce: String(row.nonce),
    expectedAnswerHash: String(row.expected_answer_hash),
    createdAt: new Date(String(row.created_at)).getTime(),
    expiresAt: new Date(String(row.expires_at)).getTime(),
    passed: Boolean(row.passed),
    proofHash: row.proof_hash == null ? null : String(row.proof_hash),
  };
}

function isExpired(c: Challenge): boolean {
  return Date.now() > c.expiresAt;
}

function newChallenge(agentId: string): Challenge {
  const id = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const bucket = Math.floor(Date.now() / 60_000);
  const prompt = sha256(`agentid:challenge:${agentId}:${bucket}`);
  const expectedAnswerHash = sha256(`${prompt}:${nonce}`);
  return {
    id,
    agentId,
    prompt,
    nonce,
    expectedAnswerHash,
    createdAt: Date.now(),
    expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
    passed: false,
    proofHash: null,
  };
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

const counters = { challenges_issued: 0 };
registerMetrics(app, { service: 'challenges', business: counters });

await applyRateLimit(app);
applyServiceAuth(app);

app.get('/healthz', async () => ({ ok: true, service: 'challenges' }));

app.post<{ Body: { agentId?: string } }>('/challenge', async (req, reply) => {
  const agentId = req.body?.agentId;
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return reply.code(400).send({ error: 'agentId is required' });
  }
  const challenge = newChallenge(agentId);
  await saveChallenge(challenge);
  counters.challenges_issued += 1;
  return reply.code(201).send({
    id: challenge.id,
    agentId: challenge.agentId,
    prompt: challenge.prompt,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
  });
});

app.get<{ Params: { id: string } }>('/challenge/:id', async (req, reply) => {
  const challenge = await loadChallenge(req.params.id);
  if (!challenge) return reply.code(404).send({ error: 'challenge not found' });
  return {
    id: challenge.id,
    agentId: challenge.agentId,
    passed: challenge.passed && !isExpired(challenge),
    expiresAt: challenge.expiresAt,
    proofHash: challenge.proofHash,
  };
});

app.post<{ Params: { id: string }; Body: { answer?: string } }>('/challenge/:id/answer', async (req, reply) => {
  const challenge = await loadChallenge(req.params.id);
  if (!challenge) return reply.code(404).send({ error: 'challenge not found' });
  if (isExpired(challenge)) return reply.code(410).send({ error: 'challenge expired' });
  const answer = req.body?.answer;
  if (typeof answer !== 'string' || answer.length === 0) {
    return reply.code(400).send({ error: 'answer is required' });
  }
  const answerHash = sha256(`${challenge.prompt}:${answer}`);
  if (answerHash !== challenge.expectedAnswerHash) {
    return reply.code(403).send({ passed: false });
  }
  const proofHash = sha256(`${challenge.id}:${challenge.expectedAnswerHash}:${answerHash}`);
  challenge.passed = true;
  challenge.proofHash = proofHash;
  await saveChallenge(challenge);
  return { passed: true, proofHash };
});

const start = async (): Promise<void> => {
  await ensureTable();
  try {
    await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== 'test') {
  void start();
}

export { app, sha256, CHALLENGE_TTL_SECONDS };
