import type { SessionEntry } from '../../../../core/session/types.js';
import type {
  SessionRouteResetMode,
  SourceChannelSessionRoute,
} from '../../../../core/session/session-routes.js';
import type {
  CogSecAffectedMessageRange,
  CogSecCaseType,
  CogSecSeverity,
} from '../../../../core/cogsec/events.js';
import type { CogSecLineagePreview } from '../../../../core/cogsec/lineage.js';
import type {
  CogSecAgentVisibleEvent,
  CogSecOperatorVisibleEvent,
} from '../../../../core/cogsec/safe-log.js';
import type { CogSecL0TombstoneResult } from '../../../../persistence/sessions/store.js';
import type { CogSecRevocationResult } from '../../../../core/cogsec/revocation.js';
import type { CogSecRegenerationResult } from '../../../../core/cogsec/regeneration.js';
import type { TurnRecord } from '../../../../shared/contracts/runtime.js';
import type {
  ChannelInfo,
  CompactionAuditView,
} from '../../types.js';
import type { MessageClass } from '../../../../core/agent/message-classes.js';
import type {
  AdminTurnStageTelemetry,
  AdminTurnRetrievalTelemetry,
  AdminTurnSnapshotData,
  AdminPromptLoomData,
} from './prompt-loom.js';
import type {
  AdminSessionRoleEnvelopePreview,
  AdminContinuityProvenanceView,
} from './continuity.js';

export type AdminSessionListRow = Pick<
  ChannelInfo,
  'sessionId' | 'channelId' | 'messageCount' | 'lastActivityAt' | 'displayLabel'
>;

export interface AdminSessionListData {
  channels: AdminSessionListRow[];
}

export interface AdminSessionDetailData {
  channel: AdminSessionListRow & Pick<ChannelInfo, 'linkedContactId' | 'linkedContactName'>;
}

export type AdminSessionRouteView = SourceChannelSessionRoute;

export interface AdminSessionRouteListData {
  routes: AdminSessionRouteView[];
  channels: AdminSessionListRow[];
}

export interface AdminSessionRouteResetInput {
  sourceChannelId: string;
  reason: string;
  actor?: string;
  mode?: SessionRouteResetMode;
}

export interface AdminSessionRouteResetData {
  ok: boolean;
  message: string;
  sourceChannelId: string;
  oldLogicalSessionId: string;
  newLogicalSessionId: string;
  route: AdminSessionRouteView;
  retiredSession: SourceChannelSessionRoute['retiredSessions'][number];
}

export interface AdminCogSecRemediationInput {
  caseId?: string;
  sourceChannelId: string;
  affectedLogicalSessionIds?: string[];
  affectedMessageRanges?: CogSecAffectedMessageRange[];
  messageIds?: number[];
  startEntryId?: number;
  endEntryId?: number;
  type: CogSecCaseType;
  severity: CogSecSeverity;
  reason: string;
  actor?: string;
  cutEpoch?: boolean;
}

export interface AdminCogSecCaseDraftView {
  caseId: string;
  type: CogSecCaseType;
  severity: CogSecSeverity;
  status: 'planned';
  sourceChannelId: string;
  affectedLogicalSessionIds: string[];
  affectedMessageRanges: CogSecAffectedMessageRange[];
  actor: string;
  safeSummary: string;
}

export interface AdminCogSecPreviewCounts {
  l0Rows: number;
  projectionRows: number;
  memories: number;
  embeddingMemoryRows: number;
  compactionSummaries: number;
  externalArtifacts: number;
  lineageGaps: number;
}

export interface AdminCogSecEventListData {
  events: CogSecOperatorVisibleEvent[];
}

export interface AdminCogSecRemediationPreviewData {
  ok: boolean;
  draft: AdminCogSecCaseDraftView;
  preview: CogSecLineagePreview;
  counts: AdminCogSecPreviewCounts;
  existingEvents: CogSecOperatorVisibleEvent[];
}

export interface AdminCogSecRouteResetResult {
  sourceChannelId: string;
  oldLogicalSessionId: string;
  newLogicalSessionId: string;
  routeGeneration?: number;
}

export interface AdminCogSecRemediationApplyData {
  ok: boolean;
  message: string;
  event: CogSecAgentVisibleEvent;
  operatorEvent: CogSecOperatorVisibleEvent;
  preview: CogSecLineagePreview;
  counts: AdminCogSecPreviewCounts;
  tombstones: CogSecL0TombstoneResult[];
  revocation: CogSecRevocationResult;
  regeneration: CogSecRegenerationResult;
  routeReset?: AdminCogSecRouteResetResult;
}

export interface AdminSessionMessageOntologyView {
  sessionEntryId: number;
  transportRole: SessionEntry['role'];
  promptRole: 'user' | 'assistant' | 'toolResult' | 'custom';
  semanticType: 'outwardSpeech' | 'toolResult' | 'systemNote' | 'mirror';
  messageClass: MessageClass | null;
  promptVisibility: 'prompt_visible' | 'operator_only';
  displayLabel: string;
}

export interface AdminSessionMessagesData {
  sessionId: string;
  channelId: string;
  messages: SessionEntry[];
  pagination: AdminSessionMessagePaginationData;
  messageOntologyViews: AdminSessionMessageOntologyView[];
  roleEnvelopePreviews: AdminSessionRoleEnvelopePreview[];
  compactionAuditViews: CompactionAuditView[];
  turns: AdminSessionTurnData[];
}

export interface AdminSessionMessagePaginationOptions {
  limit?: number;
  beforeId?: number | null;
  /**
   * Skip turn snapshots, compaction audit verification, and role-envelope
   * previews. Used by pickers (e.g. CogSec row selection) so huge sessions
   * page cheaply.
   */
  messagesOnly?: boolean;
  /**
   * Skip the up-to-50 full turn snapshots and role-envelope previews while
   * still returning compaction audit views. Defaults to true (turns included)
   * for backward compatibility with the prompt-monitor/Loom fetch. The session
   * browser sends `false` so its initial page carries messages, ontology, and
   * compaction summaries without the multi-MB turn payload; individual turn
   * detail is fetched lazily via `getSessionTurnDetail`.
   */
  includeTurns?: boolean;
}

export interface AdminSessionSearchHitView {
  messageId: number;
  role: SessionEntry['role'];
  authorId?: string;
  authorName?: string;
  content: string;
  timestamp: number;
  snippet: string;
}

export interface AdminSessionSearchData {
  sessionId: string;
  query: string;
  limit: number;
  hits: AdminSessionSearchHitView[];
}

export interface AdminSessionMessagePaginationData {
  limit: number;
  beforeId: number | null;
  nextBeforeId: number | null;
  hasMoreOlder: boolean;
  totalMessages: number;
  returnedMessages: number;
}

export interface AdminSessionTurnDetailData {
  sessionId: string;
  channelId: string;
  turn: AdminSessionTurnData;
}

export interface AdminSessionService {
  listSessions(): Promise<AdminSessionListData>;
  getSessionDetail(sessionId: string): Promise<AdminSessionDetailData>;
  /**
   * Garden transport read path. The newest page may use the optional shared
   * session tail; older cursor pages stay on the canonical bounded reader.
   */
  getSessionMessagesForAdminRead(
    sessionId: string,
    options?: AdminSessionMessagePaginationOptions,
  ): Promise<AdminSessionMessagesData>;
  /** Canonical synchronous reader used by non-transport callers and fallback. */
  getSessionMessages(sessionId: string, options?: AdminSessionMessagePaginationOptions): AdminSessionMessagesData;
  getSessionTurnDetail(sessionId: string, turnId: string): AdminSessionTurnDetailData;
  searchSessionMessages(sessionId: string, query: string, limit?: number): Promise<AdminSessionSearchData>;
  listSessionRoutes(): Promise<AdminSessionRouteListData>;
  resetSourceChannelSession(input: AdminSessionRouteResetInput): Promise<AdminSessionRouteResetData>;
  listCogSecEvents(): Promise<AdminCogSecEventListData>;
  previewCogSecRemediation(input: AdminCogSecRemediationInput): Promise<AdminCogSecRemediationPreviewData>;
  applyCogSecRemediation(input: AdminCogSecRemediationInput): Promise<AdminCogSecRemediationApplyData>;
}

export interface AdminSessionTurnData {
  record: TurnRecord;
  roleEnvelopeRefs: string[];
  continuityProvenance: AdminContinuityProvenanceView[];
  stages: AdminTurnStageTelemetry[];
  retrievals: AdminTurnRetrievalTelemetry[];
  snapshot: AdminTurnSnapshotData | null;
  promptLoom?: AdminPromptLoomData;
}
