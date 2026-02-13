// ── Persistent audit log ──
// Every gateway RPC call is logged to SQLite for review.

import Database from 'better-sqlite3';
import type { PolicyDecision } from './protocol.js';

export interface AuditEntry {
  id: number;
  timestamp: number;
  method: string;
  decision: PolicyDecision;
  paramsJson: string;
  durationMs: number | null;
  error: string | null;
}

export class AuditStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private updateDurationStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.createTable();
    this.insertStmt = this.db.prepare(`
      INSERT INTO gateway_audit (timestamp, method, decision, params_json, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.updateDurationStmt = this.db.prepare(`
      UPDATE gateway_audit SET duration_ms = ?, error = ? WHERE id = ?
    `);
  }

  private createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        method TEXT NOT NULL,
        decision TEXT NOT NULL,
        params_json TEXT,
        duration_ms INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON gateway_audit(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_method ON gateway_audit(method);
      CREATE INDEX IF NOT EXISTS idx_audit_decision ON gateway_audit(decision);
    `);
  }

  log(method: string, decision: PolicyDecision, params?: Record<string, unknown>): number {
    const paramsJson = params ? summarizeParams(params) : null;
    const result = this.insertStmt.run(Date.now(), method, decision, paramsJson, null, null);
    return Number(result.lastInsertRowid);
  }

  complete(id: number, durationMs: number, error?: string): void {
    this.updateDurationStmt.run(durationMs, error ?? null, id);
  }

  private static readonly SELECT_COLS = `
    id, timestamp, method, decision,
    params_json AS paramsJson,
    duration_ms AS durationMs,
    error`;

  getRecent(limit: number = 50): AuditEntry[] {
    const stmt = this.db.prepare(`
      SELECT ${AuditStore.SELECT_COLS} FROM gateway_audit ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(limit) as AuditEntry[];
  }

  getByMethod(method: string, limit: number = 50): AuditEntry[] {
    const stmt = this.db.prepare(`
      SELECT ${AuditStore.SELECT_COLS} FROM gateway_audit WHERE method = ? ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(method, limit) as AuditEntry[];
  }

  getApprovalEvents(limit: number = 50): AuditEntry[] {
    const stmt = this.db.prepare(`
      SELECT ${AuditStore.SELECT_COLS} FROM gateway_audit WHERE decision != 'ALLOW' ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(limit) as AuditEntry[];
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM gateway_audit').get() as { cnt: number };
    return row.cnt;
  }
}

// Summarize params for logging — redact content fields that could be large
function summarizeParams(params: Record<string, unknown>): string {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'content' && typeof value === 'string' && value.length > 200) {
      summary[key] = value.slice(0, 200) + `... (${value.length} chars)`;
    } else if (key === 'messages' && Array.isArray(value)) {
      summary[key] = `[${value.length} messages]`;
    } else if (key === 'systemPrompt' && typeof value === 'string') {
      summary[key] = `(${value.length} chars)`;
    } else if (key === 'texts' && Array.isArray(value)) {
      summary[key] = `[${value.length} texts]`;
    } else {
      summary[key] = value;
    }
  }
  return JSON.stringify(summary);
}
