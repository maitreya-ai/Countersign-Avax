// SQLite state for the countersign node: an index of on-chain escrows plus the off-chain bytes
// (evidence, judge attestations) that the chain only stores as hashes.

import type { SqlDriver } from "./db";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS escrows (
  id TEXT PRIMARY KEY,
  payer TEXT, payee TEXT, amount TEXT, deadline INTEGER,
  rubric TEXT, rubric_hash TEXT, agent_id TEXT,
  evidence_hash TEXT, state INTEGER DEFAULT 1, reason INTEGER DEFAULT 0, outcome INTEGER,
  open_tx TEXT, evidence_tx TEXT, settle_tx TEXT, final_tx TEXT, record_tx TEXT, score INTEGER,
  resource TEXT, seller TEXT, settle_gas TEXT, record_error TEXT,
  created_at INTEGER, updated_at INTEGER, block INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS evidence (
  escrow_id TEXT, evidence_hash TEXT, body TEXT, receipt_sig TEXT, submitted_by TEXT, created_at INTEGER,
  PRIMARY KEY (escrow_id, evidence_hash)
)`,
  `CREATE TABLE IF NOT EXISTS verdicts (
  escrow_id TEXT PRIMARY KEY, outcome INTEGER, attestations_json TEXT, created_at INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS jobs (
  escrow_id TEXT PRIMARY KEY, status TEXT, attempts INTEGER DEFAULT 0, last_error TEXT, updated_at INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, escrow_id TEXT, kind TEXT, tx TEXT, detail TEXT, at INTEGER
)`,
  `CREATE INDEX IF NOT EXISTS events_escrow ON events(escrow_id)`,
  `CREATE TABLE IF NOT EXISTS cursor (key TEXT PRIMARY KEY, block INTEGER)`,
];

let driver: SqlDriver | null = null;

/** Attach a SQL driver (bun:sqlite locally, Durable Object storage on Cloudflare) and create tables. */
export function initStore(d: SqlDriver) {
  driver = d;
  for (const q of SCHEMA) d.run(q);
}

function d(): SqlDriver {
  if (!driver) throw new Error("store not initialised: call initStore() first");
  return driver;
}

/** Raw access for the few ad-hoc queries outside this module. */
export const sql = {
  run: (q: string, ...p: unknown[]) => d().run(q, ...p),
  get: <T,>(q: string, ...p: unknown[]) => d().get<T>(q, ...p),
  all: <T,>(q: string, ...p: unknown[]) => d().all<T>(q, ...p),
};


export interface EscrowRow {
  id: string; payer: string; payee: string; amount: string; deadline: number;
  rubric: string; rubric_hash: string; agent_id: string | null;
  evidence_hash: string | null; state: number; reason: number; outcome: number | null;
  open_tx: string | null; evidence_tx: string | null; settle_tx: string | null; final_tx: string | null;
  record_tx: string | null; score: number | null; resource: string | null; seller: string | null;
  settle_gas: string | null; record_error: string | null;
  created_at: number; updated_at: number; block: number;
}

export interface EvidenceRow {
  escrow_id: string; evidence_hash: string; body: string; receipt_sig: string; submitted_by: string; created_at: number;
}

const now = () => Date.now();

export const store = {
  getCursor(key: string): number | null {
    const r = d().get<any>("SELECT block FROM cursor WHERE key = ?", key) as { block: number } | null;
    return r?.block ?? null;
  },
  setCursor(key: string, block: number) {
    d().run("INSERT INTO cursor (key, block) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET block = excluded.block", key, block);
  },

  upsertOpened(e: { id: string; payer: string; payee: string; amount: string; deadline: number; rubric: string; rubricHash: string; tx: string; block: number }) {
    d().run(`INSERT INTO escrows (id, payer, payee, amount, deadline, rubric, rubric_hash, open_tx, state, reason, created_at, updated_at, block)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payer=excluded.payer, payee=excluded.payee, amount=excluded.amount, deadline=excluded.deadline,
        rubric=excluded.rubric, rubric_hash=excluded.rubric_hash, open_tx=excluded.open_tx, block=excluded.block, updated_at=excluded.updated_at`, e.id, e.payer, e.payee, e.amount, e.deadline, e.rubric, e.rubricHash, e.tx, now(), now(), e.block);
  },
  update(id: string, fields: Partial<EscrowRow>) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const q = `UPDATE escrows SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`;
    d().run(q, ...keys.map((k) => (fields as any)[k]), now(), id);
  },
  ensure(id: string) {
    d().run("INSERT OR IGNORE INTO escrows (id, created_at, updated_at, block) VALUES (?, ?, ?, 0)", id, now(), now());
  },
  get(id: string): EscrowRow | null {
    return d().get<any>("SELECT * FROM escrows WHERE id = ?", id) as EscrowRow | null;
  },
  list(limit = 50): EscrowRow[] {
    return d().all("SELECT * FROM escrows WHERE payer IS NOT NULL ORDER BY created_at DESC LIMIT ?", limit) as EscrowRow[];
  },
  active(): EscrowRow[] {
    return d().all("SELECT * FROM escrows WHERE payer IS NOT NULL AND state IN (1, 4)") as EscrowRow[];
  },
  toRecord(): EscrowRow[] {
    return d().all(`SELECT * FROM escrows WHERE state IN (2, 3) AND reason IN (1, 2, 6) AND agent_id IS NOT NULL
      AND record_tx IS NULL AND (record_error IS NULL OR record_error LIKE 'retry:%')`) as EscrowRow[];
  },

  addEvidence(e: Omit<EvidenceRow, "created_at">): boolean {
    const r = d().run(`INSERT OR IGNORE INTO evidence (escrow_id, evidence_hash, body, receipt_sig, submitted_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, e.escrow_id, e.evidence_hash, e.body, e.receipt_sig, e.submitted_by, now());
    return r.changes > 0;
  },
  evidenceFor(id: string): EvidenceRow[] {
    return d().all("SELECT * FROM evidence WHERE escrow_id = ? ORDER BY created_at", id) as EvidenceRow[];
  },

  job(id: string): { status: string; attempts: number; last_error: string | null } | null {
    return d().get<any>("SELECT status, attempts, last_error FROM jobs WHERE escrow_id = ?", id) as any;
  },
  setJob(id: string, status: string, error?: string, bumpAttempts = false) {
    d().run(`INSERT INTO jobs (escrow_id, status, attempts, last_error, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(escrow_id) DO UPDATE SET status = excluded.status, last_error = excluded.last_error,
        attempts = jobs.attempts + ?, updated_at = excluded.updated_at`, id, status, bumpAttempts ? 1 : 0, error ?? null, now(), bumpAttempts ? 1 : 0);
  },

  saveVerdict(id: string, outcome: number, attestations: unknown) {
    d().run(`INSERT INTO verdicts (escrow_id, outcome, attestations_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(escrow_id) DO UPDATE SET outcome = excluded.outcome, attestations_json = excluded.attestations_json`, id, outcome, JSON.stringify(attestations), now());
  },
  verdict(id: string): { outcome: number; attestations: any[] } | null {
    const r = d().get<any>("SELECT outcome, attestations_json FROM verdicts WHERE escrow_id = ?", id) as any;
    return r ? { outcome: r.outcome, attestations: JSON.parse(r.attestations_json) } : null;
  },

  event(id: string, kind: string, tx?: string | null, detail?: string) {
    const last = d().get<any>("SELECT kind, tx FROM events WHERE escrow_id = ? ORDER BY id DESC LIMIT 1", id) as any;
    if (last && last.kind === kind && (last.tx ?? null) === (tx ?? null)) return; // de-dupe re-scans
    d().run("INSERT INTO events (escrow_id, kind, tx, detail, at) VALUES (?, ?, ?, ?, ?)", id, kind, tx ?? null, detail ?? null, now());
  },
  events(id: string) {
    return d().all("SELECT kind, tx, detail, at FROM events WHERE escrow_id = ? ORDER BY id", id);
  },
  recentEvents(limit = 30) {
    return d().all("SELECT escrow_id, kind, tx, detail, at FROM events ORDER BY id DESC LIMIT ?", limit);
  },

  stats() {
    return d().get(`SELECT
      COUNT(*) AS escrows,
      SUM(CASE WHEN reason = 1 THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN reason IN (2, 4, 5, 6) THEN 1 ELSE 0 END) AS refunded,
      SUM(CASE WHEN reason = 6 THEN 1 ELSE 0 END) AS equivocations,
      SUM(CASE WHEN state IN (1, 4) THEN 1 ELSE 0 END) AS open,
      SUM(CAST(amount AS INTEGER)) AS volume,
      SUM(CASE WHEN reason IN (2, 4, 5, 6) THEN CAST(amount AS INTEGER) ELSE 0 END) AS refunded_volume,
      SUM(CASE WHEN record_tx IS NOT NULL THEN 1 ELSE 0 END) AS records
      FROM escrows WHERE payer IS NOT NULL`);
  },
};
