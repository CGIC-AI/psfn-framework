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

export interface AuditRotationConfig {
  maxSizeBytes: number;
  maxAgeMs: number;
  maxCount: number;
}

export interface AuditSummaryEntry {
  method: string;
  decision: PolicyDecision;
  params?: Record<string, unknown>;
  durationMs?: number;
  error?: string;
}

export type AuditSummaryHook = (entry: AuditSummaryEntry) => void | Promise<void>;

export interface GatewayAuditStorePort {
  log(method: string, decision: PolicyDecision, params?: Record<string, unknown>): Promise<number>;
  complete(id: number, durationMs: number, error?: string): Promise<void>;
  recordSummary(entry: AuditSummaryEntry): Promise<number>;
  createSummaryHook(): AuditSummaryHook;
  getRecent(limit?: number): Promise<AuditEntry[]>;
  getByMethod(method: string, limit?: number): Promise<AuditEntry[]>;
  getApprovalEvents(limit?: number): Promise<AuditEntry[]>;
  count(): Promise<number>;
}
