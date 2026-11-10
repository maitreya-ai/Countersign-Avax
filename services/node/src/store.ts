// SQLite state for the countersign node: an index of on-chain escrows plus the off-chain bytes
// (evidence, judge attestations) that the chain only stores as hashes.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const path = process.env.NODE_DB ?? "data/node.db";
mkdirSync(dirname(path), { recursive: true });
export const db = new Database(path, { create: true });
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS escrows (
  id TEXT PRIMARY KEY,
  payer TEXT, payee TEXT, amount TEXT, deadline INTEGER,
  rubric TEXT, rubric_hash TEXT, agent_id TEXT,
  evidence_hash TEXT, state INTEGER DEFAULT 1, reason INTEGER DEFAULT 0, outcome INTEGER,
  open_tx TEXT, evidence_tx TEXT, settle_tx TEXT, final_tx TEXT, record_tx TEXT, score INTEGER,
  resource TEXT, seller TEXT, settle_gas TEXT, record_error TEXT,
  created_at INTEGER, updated_at INTEGER, block INTEGER
);
CREATE TABLE IF NOT EXISTS evidence (
  escrow_id TEXT, evidence_hash TEXT, body TEXT, receipt_sig TEXT, submitted_by TEXT, created_at INTEGER,
  PRIMARY KEY (escrow_id, evidence_hash)
);
CREATE TABLE IF NOT EXISTS verdicts (
  escrow_id TEXT PRIMARY KEY, outcome INTEGER, attestations_json TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS jobs (
  escrow_id TEXT PRIMARY KEY, status TEXT, attempts INTEGER DEFAULT 0, last_error TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, escrow_id TEXT, kind TEXT, tx TEXT, detail TEXT, at INTEGER
);
CREATE INDEX IF NOT EXISTS events_escrow ON events(escrow_id);
CREATE TABLE IF NOT EXISTS cursor (key TEXT PRIMARY KEY, block INTEGER);
`);

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
    const r = db.query("SELECT block FROM cursor WHERE key = ?").get(key) as { block: number } | null;
    return r?.block ?? null;
  },
  setCursor(key: string, block: number) {
    db.query("INSERT INTO cursor (key, block) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET block = excluded.block").run(key, block);
  },

  upsertOpened(e: { id: string; payer: string; payee: string; amount: string; deadline: number; rubric: string; rubricHash: string; tx: string; block: number }) {
    db.query(`INSERT INTO escrows (id, payer, payee, amount, deadline, rubric, rubric_hash, open_tx, state, reason, created_at, updated_at, block)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payer=excluded.payer, payee=excluded.payee, amount=excluded.amount, deadline=excluded.deadline,
        rubric=excluded.rubric, rubric_hash=excluded.rubric_hash, open_tx=excluded.open_tx, block=excluded.block, updated_at=excluded.updated_at`)
      .run(e.id, e.payer, e.payee, e.amount, e.deadline, e.rubric, e.rubricHash, e.tx, now(), now(), e.block);
  },
  update(id: string, fields: Partial<EscrowRow>) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sql = `UPDATE escrows SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`;
    db.query(sql).run(...(keys.map((k) => (fields as any)[k]) as any[]), now(), id);
  },
  ensure(id: string) {
    db.query("INSERT OR IGNORE INTO escrows (id, created_at, updated_at, block) VALUES (?, ?, ?, 0)").run(id, now(), now());
  },
  get(id: string): EscrowRow | null {
    return db.query("SELECT * FROM escrows WHERE id = ?").get(id) as EscrowRow | null;
  },
  list(limit = 50): EscrowRow[] {
    return db.query("SELECT * FROM escrows WHERE payer IS NOT NULL ORDER BY created_at DESC LIMIT ?").all(limit) as EscrowRow[];
  },
  active(): EscrowRow[] {
    return db.query("SELECT * FROM escrows WHERE payer IS NOT NULL AND state IN (1, 4)").all() as EscrowRow[];
  },
  toRecord(): EscrowRow[] {
    return db.query(`SELECT * FROM escrows WHERE state IN (2, 3) AND reason IN (1, 2, 6) AND agent_id IS NOT NULL
      AND record_tx IS NULL AND (record_error IS NULL OR record_error LIKE 'retry:%')`).all() as EscrowRow[];
  },

  addEvidence(e: Omit<EvidenceRow, "created_at">): boolean {
    const r = db.query(`INSERT OR IGNORE INTO evidence (escrow_id, evidence_hash, body, receipt_sig, submitted_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(e.escrow_id, e.evidence_hash, e.body, e.receipt_sig, e.submitted_by, now());
    return r.changes > 0;
  },
  evidenceFor(id: string): EvidenceRow[] {
    return db.query("SELECT * FROM evidence WHERE escrow_id = ? ORDER BY created_at").all(id) as EvidenceRow[];
  },

  job(id: string): { status: string; attempts: number; last_error: string | null } | null {
    return db.query("SELECT status, attempts, last_error FROM jobs WHERE escrow_id = ?").get(id) as any;
  },
  setJob(id: string, status: string, error?: string, bumpAttempts = false) {
    db.query(`INSERT INTO jobs (escrow_id, status, attempts, last_error, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(escrow_id) DO UPDATE SET status = excluded.status, last_error = excluded.last_error,
        attempts = jobs.attempts + ?, updated_at = excluded.updated_at`)
      .run(id, status, bumpAttempts ? 1 : 0, error ?? null, now(), bumpAttempts ? 1 : 0);
  },

  saveVerdict(id: string, outcome: number, attestations: unknown) {
    db.query(`INSERT INTO verdicts (escrow_id, outcome, attestations_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(escrow_id) DO UPDATE SET outcome = excluded.outcome, attestations_json = excluded.attestations_json`)
      .run(id, outcome, JSON.stringify(attestations), now());
  },
  verdict(id: string): { outcome: number; attestations: any[] } | null {
    const r = db.query("SELECT outcome, attestations_json FROM verdicts WHERE escrow_id = ?").get(id) as any;
    return r ? { outcome: r.outcome, attestations: JSON.parse(r.attestations_json) } : null;
  },

  event(id: string, kind: string, tx?: string | null, detail?: string) {
    const last = db.query("SELECT kind, tx FROM events WHERE escrow_id = ? ORDER BY id DESC LIMIT 1").get(id) as any;
    if (last && last.kind === kind && (last.tx ?? null) === (tx ?? null)) return; // de-dupe re-scans
    db.query("INSERT INTO events (escrow_id, kind, tx, detail, at) VALUES (?, ?, ?, ?, ?)").run(id, kind, tx ?? null, detail ?? null, now());
  },
  events(id: string) {
    return db.query("SELECT kind, tx, detail, at FROM events WHERE escrow_id = ? ORDER BY id").all(id);
  },
  recentEvents(limit = 30) {
    return db.query("SELECT escrow_id, kind, tx, detail, at FROM events ORDER BY id DESC LIMIT ?").all(limit);
  },

  stats() {
    return db.query(`SELECT
      COUNT(*) AS escrows,
      SUM(CASE WHEN reason = 1 THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN reason IN (2, 4, 5, 6) THEN 1 ELSE 0 END) AS refunded,
      SUM(CASE WHEN reason = 6 THEN 1 ELSE 0 END) AS equivocations,
      SUM(CASE WHEN state IN (1, 4) THEN 1 ELSE 0 END) AS open,
      SUM(CAST(amount AS INTEGER)) AS volume,
      SUM(CASE WHEN reason IN (2, 4, 5, 6) THEN CAST(amount AS INTEGER) ELSE 0 END) AS refunded_volume,
      SUM(CASE WHEN record_tx IS NOT NULL THEN 1 ELSE 0 END) AS records
      FROM escrows WHERE payer IS NOT NULL`).get();
  },
};
