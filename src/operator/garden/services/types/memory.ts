import type { MemoryLink } from '../../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../../faculties/memory/types.js';
import type { SharedBackgroundSource } from '../../../../faculties/memory/retrieval/shared-background.js';
import type { SensitivityLevel } from '../../../../system/trust/types.js';
import type {
  AdminMemoryManagedScopeKind,
  AdminMemoryScopeEvidenceItem,
} from '../memory-scope-evidence.js';

export interface AdminMemoryContactSummary {
  id: string;
  displayName: string;
}

/**
 * Explicit redaction descriptor for a high-intimacy memory body hidden from
 * the Garden admin memory API. The marker is honest: it names the sensitivity
 * level, the original body length, and how to reveal it.
 */
export interface AdminMemoryBodyRedaction {
  sensitivity: SensitivityLevel;
  originalLength: number;
  reason: 'high_intimacy_sensitivity';
  revealHint: string;
}

/**
 * A memory row as served by the Garden admin memory API. Identical to the
 * stored row for public/personal rows or when body access is granted;
 * otherwise `text` carries a redaction marker and `bodyRedacted` is set.
 */
export type AdminMemoryView = PurrMemory & {
  bodyRedacted?: boolean;
  bodyRedaction?: AdminMemoryBodyRedaction;
};

/** Session-elevation state for reading high-intimacy memory bodies. */
export interface AdminMemoryElevationStatus {
  elevated: boolean;
  expiresAt?: number;
  ttlMs: number;
}

export interface AdminMemoryPrivacySummary {
  activeMemoryCount: number;
  matchingMemoryCount: number;
  pageMemoryCount: number;
  highSensitivityCount: number;
  consentGatedCount: number;
  contactLinkedCount: number;
  scopedCount: number;
  preferenceCount: number;
  durablePreferenceCount: number;
  sensitivityCounts: Record<string, number>;
}

export interface AdminMemoryListData {
  memories: AdminMemoryView[];
  contactsById: Map<string, AdminMemoryContactSummary>;
  privacySummary: AdminMemoryPrivacySummary;
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  elevation: AdminMemoryElevationStatus;
}

export interface AdminMemoryDetailData {
  memory: AdminMemoryView;
  linkedContact?: AdminMemoryContactSummary;
  scopeAssignments: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
  elevation: AdminMemoryElevationStatus;
}

export interface AdminMemorySearchResult {
  query: string;
  results: AdminMemoryView[];
  contactsById: Map<string, AdminMemoryContactSummary>;
  privacySummary: AdminMemoryPrivacySummary;
  elevation: AdminMemoryElevationStatus;
}

/** One shared-background item in the operator/admin view (E4.5). */
export interface AdminSharedBackgroundItem {
  /** Body redaction is inherited from the E3.5 admin body gate. */
  memory: AdminMemoryView;
  sources: SharedBackgroundSource[];
  score: number;
}

/** Operator/admin shared-background query result ("what links A and B"). */
export interface AdminSharedBackgroundResult {
  contactAId: string;
  contactBId: string;
  contactADisplayName?: string;
  contactBDisplayName?: string;
  resolved: boolean;
  missingContactIds: string[];
  items: AdminSharedBackgroundItem[];
  contactsById: Map<string, AdminMemoryContactSummary>;
  totalCandidates: number;
  truncated: boolean;
  limit: number;
  elevation: AdminMemoryElevationStatus;
}

export interface MemoryMutationResult {
  ok: boolean;
  message?: string;
}

export interface AdminMemoryLinkResult {
  ok: boolean;
  link?: MemoryLink;
  message?: string;
}

export interface AdminBulkMutationResult {
  ok: boolean;
  count: number;
  message?: string;
}

export interface AdminMemoryScopeAssignmentView {
  kind: AdminMemoryManagedScopeKind;
  id: string;
  label?: string;
  canonicalTag: string;
  evidence: AdminMemoryScopeEvidenceItem[];
}

export interface AdminMemoryScopeRepairView {
  needsRepair: boolean;
  suggestedScopeRef?: {
    kind: string;
    id: string;
    label?: string;
  };
  suggestedScopeTags: string[];
  notes: string[];
}

export interface AdminMemoryScopeSummary {
  kind: AdminMemoryManagedScopeKind;
  id: string;
  label?: string;
  canonicalTag: string;
  memoryCount: number;
  needsRepairCount: number;
}

export interface AdminMemoryScopedMemoryView {
  memory: AdminMemoryView;
  evidence: AdminMemoryScopeEvidenceItem[];
  repair: AdminMemoryScopeRepairView;
}

export interface AdminMemoryScopeListData {
  scopes: AdminMemoryScopeSummary[];
}

export interface AdminMemoryScopeDetailData {
  scope: AdminMemoryScopeSummary;
  memories: AdminMemoryScopedMemoryView[];
  elevation: AdminMemoryElevationStatus;
}

export interface AdminMemoryScopeMutationResult extends MemoryMutationResult {
  memory?: AdminMemoryDetailData['memory'];
  scopeAssignments?: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
}

/**
 * Identity of the requesting admin session for body-gate grants. `null`
 * means no session identity could be derived from the request; the gate
 * fail-closes to redacted bodies and refuses new grants for that case.
 */
export type AdminMemorySessionKey = string | null;

export interface AdminMemoryService {
  /**
   * Binds the per-request admin session identity. Body-gate grants
   * (elevation and reveals) are keyed by this identity so one operator's
   * grants never leak memory bodies to other concurrent admin sessions.
   */
  forSession(sessionKey: AdminMemorySessionKey): AdminMemorySessionService;
}

export interface AdminMemorySessionService {
  listMemories(params?: URLSearchParams): Promise<AdminMemoryListData>;
  getMemoryDetail(id: string): Promise<AdminMemoryDetailData | null>;
  listManagedScopes(params?: URLSearchParams): Promise<AdminMemoryScopeListData>;
  getManagedScopeDetail(kind: string, id: string): Promise<AdminMemoryScopeDetailData | null>;
  searchMemories(query: string): Promise<AdminMemorySearchResult>;
  /**
   * Shared-background query (E4.5): the union of memories linking two contacts.
   * Bodies inherit the E3.5 admin body gate (redacted unless revealed/elevated).
   */
  sharedBackground(
    contactAId: string,
    contactBId: string,
    limit?: number,
  ): Promise<AdminSharedBackgroundResult>;
  supersedeMemory(id: string): Promise<MemoryMutationResult>;
  updateMemoryScope(
    id: string,
    fields: {
      scopeRef?: { kind?: string; id?: string; label?: string } | null;
      scopeTags?: string[];
      repair?: boolean;
    },
  ): Promise<AdminMemoryScopeMutationResult>;
  linkMemories(id1: string, id2: string, linkType?: string): Promise<AdminMemoryLinkResult>;
  unlinkMemories(id1: string, id2: string): Promise<MemoryMutationResult>;
  getMemoryLinks(id: string): Promise<MemoryLink[]>;
  bulkDelete(ids: string[]): Promise<AdminBulkMutationResult>;
  bulkUpdate(ids: string[], fields: { memoryType?: string; sensitivity?: string; retentionClass?: string }): Promise<AdminBulkMutationResult>;
  /** Current session-elevation state for high-intimacy memory bodies. */
  getBodyElevationStatus(): AdminMemoryElevationStatus;
  /** Grants TTL-bound access to all high-intimacy memory bodies. Audit-logged. */
  elevateBodyAccess(): AdminMemoryElevationStatus;
  /** Ends an active body-access elevation immediately. Audit-logged. */
  dropBodyElevation(): AdminMemoryElevationStatus;
  /** Reveals a single memory body (TTL-bound grant for that id). Audit-logged when it uncovers a high-intimacy body. */
  revealMemory(id: string): Promise<AdminMemoryDetailData | null>;
}
