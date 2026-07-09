// ── Admin GUI Types ──

export type DashboardCostWindow = 'today' | 'week' | 'month';

export interface DashboardCostWindowUsage {
  turns: number;
  llmCalls: number;
  toolCalls: number;
  estimatedCostUsd: number;
}

export interface DashboardCostWindowTotals {
  today: DashboardCostWindowUsage;
  week: DashboardCostWindowUsage;
  month: DashboardCostWindowUsage;
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
  sessionUsage: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    llmCalls: number;
    toolCalls: number;
    lastTtftMs: number | null;
    averageTtftMs: number | null;
    activeSessionContextPressure: DashboardSessionContextPressure;
    estimatedCostUsd: number;
    costWindows: {
      selected: DashboardCostWindow;
      byWindow: DashboardCostWindowTotals;
    };
  };
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
  | 'gateway_policy';
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
  entries: AdminAuditHistoryEntry[];
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
  maintenanceIntervalMs: number;
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
