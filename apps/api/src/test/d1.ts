// A D1Database over sql.js (SQLite in wasm) with every migration applied, so tests run
// the real SQL — RETURNING, json_each, ON CONFLICT, foreign keys — instead of a mock.
import initSqlJs, { type Database, type SqlValue } from 'sql.js';

declare global {
  interface ImportMeta {
    glob(pattern: string, opts: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

// Vite inlines the files at transform time, so this needs no node:fs (or its types).
const MIGRATIONS = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true });

class Statement {
  constructor(readonly db: Database, readonly sql: string, readonly params: SqlValue[] = []) {}
  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params.map((p) => (p === undefined ? null : (p as SqlValue))));
  }
  rows(): Record<string, unknown>[] {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(this.params);
      const out: Record<string, unknown>[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }
  async first<T>() { return (this.rows()[0] ?? null) as T | null; }
  async all<T>() { return { results: this.rows() as T[], success: true }; }
  async run() { this.rows(); return { success: true, meta: { changes: this.db.getRowsModified() } }; }
}

export async function createTestD1() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  for (const path of Object.keys(MIGRATIONS).sort()) db.run(MIGRATIONS[path]);
  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(stmts: Statement[]) {
      db.run('BEGIN');
      try {
        const out = stmts.map((s) => ({ results: s.rows(), success: true }));
        db.run('COMMIT');
        return out;
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
    },
    exec: async (sql: string) => { db.run(sql); },
  };
  return { d1: d1 as unknown as D1Database, sqlite: db };
}
