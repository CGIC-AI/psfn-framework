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

export interface AuditAppendEntry {
  method: string;
  decision: PolicyDecision;
  params?: Record<string, unknown>;
}

export type AuditSummaryHook = (entry: AuditSummaryEntry) => void | Promise<void>;

export interface GatewayAuditStorePort {
  append(entry: AuditAppendEntry): Promise<number>;
  complete(id: number, durationMs: number, error?: string): Promise<void>;
  recordSummary(entry: AuditSummaryEntry): Promise<number>;
  createSummaryHook(): AuditSummaryHook;
  enforceRotation(referenceTimeMs?: number): Promise<void>;
  getRecent(limit?: number): Promise<AuditEntry[]>;
  getByMethod(method: string, limit?: number): Promise<AuditEntry[]>;
  getApprovalEvents(limit?: number): Promise<AuditEntry[]>;
  count(): Promise<number>;
}

export interface GatewayAuditHistoryQuery {
  limit?: number;
  offset?: number;
  method?: string;
  decision?: AuditEntry['decision'];
  sinceMs?: number;
  untilMs?: number;
  query?: string;
}

export interface GatewayAuditHistoryPage {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}
