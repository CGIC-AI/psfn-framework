// ── Admin GUI Types ──

import type { TurnPerformanceSnapshot } from '../../shared/telemetry/turn-performance.js';

export type DashboardCostWindow = 'today' | 'week' | 'month';

export interface DashboardCostWindowUsage {
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  providerCostUsd: number;
  estimatedCostUsd: number;
  effectiveCostUsd: number;
}

export type DashboardModelUsageState = 'fresh' | 'stale' | 'unavailable';

export interface DashboardModelUsageFreshness {
  state: DashboardModelUsageState;
  source: 'postgres_model_usage';
  refreshedAtMs: number | null;
  dataThroughMs: number | null;
  latestEventAtMs: number | null;
  refreshIntervalMs: number;
  message?: string;
}

export interface DashboardModelUsageProjection {
  selected: DashboardCostWindow;
  usage: DashboardCostWindowUsage | null;
  freshness: DashboardModelUsageFreshness;
}

export interface DashboardTransientSessionTelemetry {
  source: 'live_event_bus';
  turnsSinceOperatorStart: number;
  lastTtftMs: number | null;
  averageTtftMs: number | null;
  latencyPercentiles: TurnPerformanceSnapshot;
  activeSessionContextPressure: DashboardSessionContextPressure;
}

export interface DashboardSessionContextPressure {
  sessionId: string | null;
  utilizationPct: number;
  hasTelemetry: boolean;
}

export interface DashboardToolStatus {
  name: string;
  status: 'healthy' | 'degraded' | 'unavailable' | 'not_applicable';
  detail?: string;
}

export interface DashboardStats {
  memoryTotal: number;
  memoryByType: Record<string, number>;
  avgSalience: number;
  sessionCount: number;
  schedulerTasks: number;
  activeShards: number;
  modelUsage: DashboardModelUsageProjection;
  transientSessionTelemetry: DashboardTransientSessionTelemetry;
  toolStatus: DashboardToolStatus[];
  recentAnalysisWorkbenchTraces: AnalysisWorkbenchTraceView[];
}

export interface AnalysisWorkbenchTraceStepView {
  iteration: number;
  inputTokens: number;
  outputTokens: number;
  cumulativeTokens: number;
  durationMs: number;
  code: string;
  output: string;
  error: string | null;
  variablesChanged: string[];
}

export interface AnalysisWorkbenchTraceView {
  timestamp: number;
  task: string;
  iterations: number;
  totalTokens: number;
  durationMs: number;
  truncated: boolean;
  budgetStop: string | null;
  steps: AnalysisWorkbenchTraceStepView[];
}

export interface AdminEvent {
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export type AdminAuditActionType =
  | 'tool_invocation'
  | 'tool_activation'
  | 'identity_edit'
  | 'external_action'
  | 'memory_mutation'
  | 'memory_access'
  | 'settings_change'
  | 'confirmation'
  | 'charge_decision'
  | 'gateway_policy'
  | 'autonomy_control';
export type AdminAuditDecision = 'allowed' | 'denied' | 'needs_approval';
export type AdminAuditTimeRange = '15m' | '1h' | '24h' | '7d' | '30d' | 'all';
export type AdminAuditActor = 'operator' | 'companion';
export type AdminAuditHistorySource = 'garden' | 'gateway' | 'charge';

export interface AdminAuditTimelineEntry {
  id: string;
  timestamp: number;
  actionType: AdminAuditActionType;
  decision: AdminAuditDecision;
  narrative: string;
  details?: string;
  actor?: AdminAuditActor;
}

export interface AdminAuditTimelineFilters {
  actionType: AdminAuditActionType | 'all';
  decision: AdminAuditDecision | 'all';
  timeRange: AdminAuditTimeRange;
}

export interface AdminAuditHistoryEntry extends AdminAuditTimelineEntry {
  source: AdminAuditHistorySource;
  sourceRecordId?: string;
  raw?: Record<string, unknown>;
}

export interface AdminAuditHistoryListEntry extends AdminAuditTimelineEntry {
  source: AdminAuditHistorySource;
}

export interface AdminAuditHistoryDetailData {
  entry: AdminAuditHistoryListEntry;
  raw: Record<string, unknown> | null;
}

export interface AdminAuditHistoryFilters extends AdminAuditTimelineFilters {
  source: AdminAuditHistorySource | 'all';
  query?: string;
  limit: number;
  offset: number;
}

export interface AdminAuditHistoryPagination {
  limit: number;
  offset: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface AdminAuditHistoryData {
  entries: AdminAuditHistoryListEntry[];
  filters: AdminAuditHistoryFilters;
  pagination: AdminAuditHistoryPagination;
  sources: {
    garden: { available: boolean; count: number };
    gateway: { available: boolean; count: number; message?: string };
    charge: { available: boolean; count: number; message?: string };
  };
}

export type AdminChatDebugCategory = 'thinking' | 'text' | 'tools' | 'memory' | 'errors';

export type AdminChatDebugDetailValue = string | number | boolean | null;

export interface AdminChatDebugEventPayload {
  id: string;
  timestamp: number;
  event: string;
  category: AdminChatDebugCategory;
  channelId?: string;
  message: string;
  details?: Record<string, AdminChatDebugDetailValue>;
}

export interface AdminChatDebugStreamOptions {
  channelId?: string;
}

export interface ChannelInfo {
  sessionId: string;
  channelId: string;
  messageCount: number;
  lastActivityAt?: number;
  displayLabel?: string;
  linkedContactId?: string;
  linkedContactName?: string;
}

export type CompactionAuditVerification = 'verified' | 'mismatch' | 'missing_hash' | 'missing_source';

export interface CompactionAuditView {
  id: number;
  createdAt: number;
  coveredUpTo: number;
  summary: string;
  sourceHash: string | null;
  sourceFirstMessageId: number | null;
  sourceLastMessageId: number | null;
  sourceMessageCount: number | null;
  verification: CompactionAuditVerification;
  verificationDetail: string;
}

export interface EnvInfo {
  salienceFloor: number;
  backgroundMaintenanceIntervalMs: number;
  discordToken: string;
  apiKey: string;
  adminToken: string;
  openrouterApiKey: string;
  litellmBaseUrl: string;
  litellmApiKey: string;
  importProcessingLocalApiKey: string;
  falApiKey: string;
  telegramBotToken: string;
}
