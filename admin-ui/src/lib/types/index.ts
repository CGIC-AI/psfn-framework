// ── Types mirroring server interfaces ──
// Kept minimal — only what the UI needs to render

export type MemoryType =
  | 'episodic'
  | 'semantic'
  | 'emotional'
  | 'procedural'
  | 'boundary'
  | 'reflection'
  | 'relational';

export type SensitivityLevel = 'public' | 'personal' | 'intimate' | 'confidential';

export type TrustLevel = 'primary' | 'trusted' | 'regular' | 'public';

export type RelationshipType = 'partner' | 'family' | 'friend' | 'acquaintance' | 'stranger' | 'ai_companion';

export type LayerType = 'base' | 'operator' | 'runtime' | 'channel' | 'task';

export type MemoryRetentionClass = 'standard' | 'durable';

export interface PurrMemory {
  id: string;
  text: string;
  type: MemoryType;
  importance: number;
  confidence: number;
  emotionalValence: number;
  salience: number;
  sourceRef: string;
  extractedAt: number;
  lastAccessed: number;
  accessCount: number;
  supersededBy?: string;
  tags: string[];
  provenanceRefs?: string[];
  retentionClass?: MemoryRetentionClass;
  sensitivity: SensitivityLevel;
  contactId?: string;
  deletedAt?: number;
  deletedBy?: string;
  deleteReason?: string;
}

export interface Contact {
  id: string;
  discordUserId?: string;
  nickname?: string;
  displayName: string;
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  emotionalBaseline?: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
  notes?: string;
}

export interface PromptLayer {
  id: string;
  type: LayerType;
  name: string;
  identifier?: string;
  role?: 'system' | 'user' | 'assistant';
  promptOrder?: number;
  content: string;
  enabled: boolean;
  priority: number;
  channelType?: string;
  taskKind?: string;
  updatedAt: string;
  updatedBy: string;
  checksum: string;
  version: number;
}

export interface PromptRegistryEntry {
  key: string;
  name: string;
  content: string;
  enabled: boolean;
  category?: string;
  updatedAt: string;
  version: number;
}

export interface SessionEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  channelId?: string;
  userId?: string;
  toolCalls?: unknown[];
  originChannelId?: string;
}

export interface ChannelInfo {
  channelId: string;
  messageCount: number;
  displayLabel?: string;
  linkedContactId?: string;
  linkedContactName?: string;
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
    avgContextUtilization: number;
    estimatedCostUsd: number;
  };
  recentThinkTraces: ThinkTraceView[];
}

export interface ThinkTraceView {
  id: string;
  channelId: string;
  iterations: number;
  tokens: number;
  durationMs: number;
  evidenceCount: number;
  timestamp: number;
}

export interface CompactionAuditView {
  timestamp: string;
  beforeCount: number;
  afterCount: number;
  summary: string;
}

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
    creator: string;
    character_version: string;
    tags: string[];
    extensions: Record<string, unknown>;
  };
}

export interface ContactProfileArtifact {
  contactId: string;
  displayName: string;
  memoryCount: number;
}

export interface ContactConversationChannelView {
  channel: string;
  channelId: string;
  firstSeen: string;
  lastSeen: string;
}

export interface ContactIdentityLinkVerification {
  id: string;
  contactId: string;
  sourceChannel: string;
  sourceUserId: string;
  targetChannel: string;
  targetUserId: string;
  status: 'pending' | 'verified' | 'failed' | 'expired';
  createdAt: string;
  updatedAt: string;
}

export interface ContactMutationAuditEntry {
  id: number;
  contactId: string;
  actor: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  timestamp: string;
}

export interface DiscoveredModel {
  id: string;
  description?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  pricing?: { prompt: number; completion: number };
}

export interface EnvInfo {
  nodeVersion: string;
  platform: string;
  arch: string;
  uptime: number;
  memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
}

// ── API Response wrappers ──

export interface AdminDashboardData {
  stats: DashboardStats;
}

export interface AdminMemoryListData {
  memories: PurrMemory[];
  contactsById: Record<string, { id: string; displayName: string }>;
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
  linkedContact?: { id: string; displayName: string };
}

export interface AdminMemorySearchResult {
  query: string;
  results: PurrMemory[];
  contactsById: Record<string, { id: string; displayName: string }>;
}

export interface AdminSessionListData {
  channels: ChannelInfo[];
}

export interface AdminSessionMessagesData {
  channelId: string;
  messages: SessionEntry[];
  compactionAuditViews: CompactionAuditView[];
}

export interface AdminIdentityData {
  card: CharacterCardV2;
  version: number;
  checksum?: string;
  history: Array<{ version: number; timestamp: string; changedBy: string }>;
  intakeReview: unknown | null;
}

export interface AdminSettingsData {
  config: Record<string, unknown>;
  env: EnvInfo;
  editors: {
    models: unknown;
    skills: unknown;
    scheduler: unknown;
    trustPolicy: unknown;
    capabilities: unknown;
  };
}

export interface AdminContactListData {
  contacts: Contact[];
  profileMap: Record<string, ContactProfileArtifact>;
  relatedChannelMap: Record<string, ContactConversationChannelView[]>;
  verifications: ContactIdentityLinkVerification[];
  mutationAudits: ContactMutationAuditEntry[];
}

export interface AdminContactDetailData {
  contact: Contact;
  profile?: ContactProfileArtifact;
  relatedChannels: ContactConversationChannelView[];
}

export interface AdminPromptListData {
  layers: PromptLayer[];
  staticPrompts: PromptRegistryEntry[];
}

export interface AdminPromptDetailData {
  layer?: PromptLayer;
  layerHistory?: Array<{
    layerId: string;
    previousContent: string;
    newContent: string;
    updatedBy: string;
    reason?: string;
    timestamp: string;
    version: number;
  }>;
  staticPrompt?: PromptRegistryEntry;
}

export interface AdminChatBootstrapResponse {
  adminToken: string;
  chatCompletionsUrl: string;
  voiceWebSocketUrl?: string;
  agentName: string;
}

// WebSocket telemetry event
export interface TelemetryEvent {
  type: string;
  timestamp: number;
  data: unknown;
}
