// Dashboard
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
    avgContextUtilization: number;
    estimatedCostUsd: number;
  };
  recentThinkTraces: ThinkTraceView[];
}

export interface ThinkTraceStepView {
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

export interface ThinkTraceView {
  timestamp: number;
  task: string;
  iterations: number;
  totalTokens: number;
  durationMs: number;
  truncated: boolean;
  budgetStop: string | null;
  steps: ThinkTraceStepView[];
}

export interface AdminDashboardData {
  stats: DashboardStats;
}

// Memory
export interface PurrMemory {
  id: string;
  type: string;
  content: string;
  importance: number;
  salience: number;
  emotionalWeight: number;
  sensitivity?: string;
  contactId?: string;
  createdAt: number;
  updatedAt: number;
  supersededAt?: number;
  supersededBy?: string;
}

export interface AdminMemoryContactSummary {
  id: string;
  displayName: string;
}

export interface AdminMemoryListData {
  memories: PurrMemory[];
  contactsById: Record<string, AdminMemoryContactSummary>;
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}

export interface AdminMemoryDetailData {
  memory: PurrMemory;
  linkedContact?: AdminMemoryContactSummary;
}

export interface AdminMemorySearchResult {
  query: string;
  results: PurrMemory[];
  contactsById: Record<string, AdminMemoryContactSummary>;
}

// Sessions
export interface ChannelInfo {
  channelId: string;
  messageCount: number;
  displayLabel?: string;
  linkedContactId?: string;
  linkedContactName?: string;
}

export interface SessionEntry {
  role: string;
  content: string;
  timestamp?: string;
  toolCalls?: unknown[];
  originChannelId?: string;
}

export interface CompactionAuditView {
  id: number;
  createdAt: number;
  coveredUpTo: number;
  summary: string;
  sourceHash: string | null;
  sourceMessageCount: number | null;
  verification: string;
  verificationDetail: string;
}

export interface AdminSessionListData {
  channels: ChannelInfo[];
}

export interface AdminSessionMessagesData {
  channelId: string;
  messages: SessionEntry[];
  compactionAuditViews: CompactionAuditView[];
}

// Contacts
export interface Contact {
  id: string;
  displayName: string;
  nickname?: string;
  trustLevel: string;
  relationshipType: string;
  firstSeen: string;
  lastSeen: string;
  notes?: string;
}

export interface ContactProfileArtifact {
  memoryCount: number;
}

export interface ContactConversationChannelView {
  channel: string;
  userId: string;
  privacyLevel: string;
}

export interface AdminContactListData {
  contacts: Contact[];
  profileMap: Record<string, ContactProfileArtifact>;
  relatedChannelMap: Record<string, ContactConversationChannelView[]>;
  verifications: unknown[];
  mutationAudits: unknown[];
  mutationAuditQuery: unknown;
}

export interface ContactUpdateResult {
  ok: boolean;
  message: string;
  contact?: Contact;
}

// Settings
export interface AdminSettingsData {
  config: Record<string, unknown>;
  env: Record<string, unknown>;
  editors: {
    models: unknown;
    skills: unknown;
    scheduler: unknown;
    trustPolicy: unknown;
    capabilities: unknown;
  };
}

export interface ConfigUpdateResult {
  ok: boolean;
  message: string;
}

// Identity
export interface CharacterCardV2 {
  spec: string;
  spec_version: string;
  data: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    system_prompt: string;
    post_history_instructions: string;
    tags: string[];
    creator: string;
    creator_notes: string;
    character_version: string;
    extensions: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface AdminIdentityData {
  card: CharacterCardV2;
  config: Record<string, unknown>;
  version: number;
  checksum?: string;
  history: Array<{ version: number; timestamp: string; checksum?: string }>;
  intakeReview: unknown;
}

// Prompts
export interface PromptLayer {
  id: string;
  type: string;
  name: string;
  content: string;
  enabled: boolean;
  priority: number;
  metadata?: Record<string, unknown>;
}

export interface PromptRegistryEntry {
  key: string;
  name: string;
  content: string;
  description?: string;
}

export interface AdminPromptListData {
  layers: PromptLayer[];
  staticPrompts: PromptRegistryEntry[];
}

export interface PromptUpdateResult {
  ok: boolean;
  message: string;
  layer?: PromptLayer;
}

// Chat
export interface AdminChatBootstrapResponse {
  contactOptions: Array<{
    canonicalContactId: string;
    displayName: string;
    nickname?: string;
    linkedChannels: Array<{
      channel: string;
      userId: string;
      privacyLevel: string;
    }>;
  }>;
  canonicalContactId: string;
  displayName: string;
  nickname?: string;
  linkedChannels: Array<{
    channel: string;
    userId: string;
    privacyLevel: string;
  }>;
  selectedIdentity: {
    canonicalContactId: string;
    channel: string;
    userId: string;
    privacyLevel: string;
  };
  privacy: {
    availableLevels: string[];
    selectedLevel: string;
  };
  api: {
    chatCompletionsUrl: string;
    voiceWebSocketUrl: string;
    apiKey?: string;
  };
  runtime: {
    assets: {
      moduleUrl: string;
      stylesheetUrl: string;
    };
    transportHeaders: Record<string, string>;
    model: {
      id: string;
      name: string;
      provider: string;
      api: string;
      baseUrl: string;
      headers: Record<string, string>;
    };
    apiKey?: string;
  };
  defaultSessionId: string;
  defaultAuthorName: string;
  defaultAuthorId: string;
}

// Models
export interface DiscoveredModel {
  id: string;
  description?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  pricing?: { prompt?: number; completion?: number };
}

// Telemetry
export interface TelemetryEvent {
  type: string;
  timestamp: number;
  data: unknown;
}
