// bun:sqlite driver (local runs and the Docker image). Kept out of the Workers bundle.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlDriver } from "./db";

export function bunDriver(path = process.env.NODE_DB ?? "data/node.db"): SqlDriver {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  return {
    run: (q, ...p) => ({ changes: db.query(q).run(...(p as any[])).changes }),
    get: <T,>(q: string, ...p: unknown[]) => (db.query(q).get(...(p as any[])) as T) ?? null,
    all: <T,>(q: string, ...p: unknown[]) => db.query(q).all(...(p as any[])) as T[],
  };
}
