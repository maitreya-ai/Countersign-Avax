// Minimal SQL driver interface so the same store runs on bun:sqlite (local) and on a
// Cloudflare Durable Object's SQLite storage (production).

export interface SqlDriver {
  run(sql: string, ...params: unknown[]): { changes: number };
  get<T>(sql: string, ...params: unknown[]): T | null;
  all<T>(sql: string, ...params: unknown[]): T[];
}

/** Durable Object storage: ctx.storage.sql */
export function durableObjectDriver(sql: {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}): SqlDriver {
  const norm = (p: unknown[]) => p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
  return {
    run(q, ...p) {
      const c = sql.exec(q, ...norm(p));
      c.toArray();
      return { changes: c.rowsWritten };
    },
    get<T>(q: string, ...p: unknown[]) {
      return (sql.exec(q, ...norm(p)).toArray()[0] as T) ?? null;
    },
    all<T>(q: string, ...p: unknown[]) {
      return sql.exec(q, ...norm(p)).toArray() as T[];
    },
  };
}
