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

// Memory -- mirrors backend PurrMemory from src/memory/types.ts
export interface PurrMemory {
  id: string;
  text: string;
  type: string;
  importance: number;
  confidence: number;
  emotionalValence: number;
  salience: number;
  sourceRef: string;
  extractedAt: number;
  lastAccessed: number;
  accessCount: number;
  tags: string[];
  provenanceRefs?: string[];
  sensitivity?: string;
  consentFlags?: Record<string, unknown>;
  contactId?: string;
  supersededBy?: string;
  deletedAt?: number;
  // Legacy compat fields (old frontend code may reference these)
  content?: string;
  createdAt?: number;
  updatedAt?: number;
  emotionalWeight?: number;
  supersededAt?: number;
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
  authorName?: string;
  authorId?: string;
  timestamp?: string;
  toolCalls?: unknown[];
  originChannelId?: string;
  channelVisibility?: string;
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
export interface ContactChannelIdentity {
  channel: string;
  userId: string;
}

export interface ContactChannelLink extends ContactChannelIdentity {
  privacyLevel: ChannelPrivacyLevel;
  firstSeen?: string;
  lastSeen?: string;
}

export type ChannelPrivacyLevel = 'private' | 'semi_private' | 'public' | 'broadcast';

export interface Contact {
  id: string;
  displayName: string;
  nickname?: string;
  discordUserId?: string;
  trustLevel: string;
  relationshipType: string;
  channelIdentities?: ContactChannelIdentity[];
  channels?: ContactChannelLink[];
  emotionalBaseline?: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
  notes?: string;
}

export interface ContactProfileArtifact {
  memoryCount: number;
  displayName?: string;
  summary?: string;
  updatedAt?: number;
  sourceMemoryIds?: string[];
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
  verifications: ContactIdentityLinkVerification[];
  mutationAudits: ContactMutationAuditEntry[];
  mutationAuditQuery: unknown;
}

export interface ContactUpdateResult {
  ok: boolean;
  message: string;
  contact?: Contact;
  relatedChannels?: ContactConversationChannelView[];
}

export type TrustLevel = 'primary' | 'trusted' | 'regular' | 'public';

export type RelationshipType = 'partner' | 'family' | 'friend' | 'acquaintance' | 'stranger' | 'ai_companion';

export const RELATIONSHIP_TYPES: RelationshipType[] = [
  'partner', 'family', 'friend', 'acquaintance', 'stranger', 'ai_companion',
];

export const CHANNEL_PRIVACY_LEVELS: ChannelPrivacyLevel[] = [
  'private', 'semi_private', 'public', 'broadcast',
];

export interface ContactIdentityLinkVerification {
  id: string;
  status: string;
  sourceChannel: string;
  sourceUserId: string;
  targetChannel: string;
  targetUserId: string;
  contactId: string;
  nonce?: string;
  expiresAt?: string;
}

export interface ContactMutationAuditEntry {
  id: string;
  contactId: string;
  field: string;
  actor: string;
  oldValue?: string;
  newValue?: string;
  timestamp: string;
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

export interface CharacterCardHistoryEntry {
  version: number;
  timestamp: string;
  updatedBy: string;
  reason?: string;
  previousChecksum: string;
  newChecksum: string;
  previousCard?: CharacterCardV2;
  newCard?: CharacterCardV2;
  // Legacy compat -- old API responses used changedBy instead of updatedBy
  changedBy?: string;
  checksum?: string;
}

export interface AdminIdentityData {
  card: CharacterCardV2;
  config: Record<string, unknown>;
  version: number;
  checksum?: string;
  history: CharacterCardHistoryEntry[];
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
  identifier?: string;
  role?: string;
  promptOrder?: number;
  channelType?: string;
  taskKind?: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  checksum: string;
}

export interface PromptHistoryEntry {
  layerId: string;
  layerName: string;
  previousContent: string;
  previousChecksum: string;
  newContent: string;
  newChecksum: string;
  updatedBy: string;
  reason?: string;
  timestamp: string;
  version: number;
}

export interface AdminPromptDetailData {
  layer?: PromptLayer;
  layerHistory?: PromptHistoryEntry[];
  staticPrompt?: PromptRegistryEntry;
  staticPromptHistory?: PromptRegistryHistoryEntry[];
}

export interface PromptRegistryHistoryEntry {
  version: number;
  updatedBy: string;
  timestamp: string;
  previousChecksum: string;
  previousText: string;
}

export interface PromptDiffResult {
  oldContent: string;
  newContent: string;
}

export interface PromptRegistryEntry {
  key: string;
  name?: string;
  content?: string;
  text?: string; // Backend uses `text`, not `content`
  description?: string;
  consumers?: string[];
  version?: number;
  enabled?: boolean;
  category?: string;
  updatedAt?: string;
  updatedBy?: string;
  checksum?: string;
  identifier?: string;
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

export interface AdminModelRoomParticipant {
  id: string;
  slotKey: string;
  purpose: string;
  displayName: string;
  provider: string;
  model: string;
  maxTokens?: number;
  contextWindow?: number;
  defaultSystemPrompt?: string;
}

export interface AdminModelRoomBootstrapResponse {
  api: {
    chatCompletionsUrl: string;
    apiKey?: string;
  };
  defaultRoomId: string;
  psfn: {
    id: string;
    displayName: string;
    defaultSystemPromptMode: 'default';
  };
  participants: AdminModelRoomParticipant[];
  constraints: {
    allowedProviders: string[];
    deniedProviders: string[];
  };
}

// Models
export interface DiscoveredModel {
  id: string;
  description?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  pricing?: { prompt?: number; completion?: number };
}

// Scheduler
export type TaskType = 'every' | 'one-shot';
export type TaskState = 'idle' | 'active' | 'paused' | 'complete';

export interface ScheduledTask {
  id: string;
  name: string;
  type: TaskType;
  intervalMs: number;
  runAt?: number;
  state: TaskState;
}

export interface ReflectionDeliberationConfig {
  maxRounds?: number;
  maxTotalTokens?: number;
  maxWallTimeMs?: number;
  voices?: Array<'background' | 'reasoning'>;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
}

export interface ReflectionTemplate {
  id: string;
  name: string;
  prompt: string;
  intervalMs: number;
  enabled: boolean;
  sendToDiscord: boolean;
  mode?: 'standard' | 'deliberation';
  deliberation?: ReflectionDeliberationConfig;
}

export interface AdminSchedulerData {
  tasks: ScheduledTask[];
  reflections: ReflectionTemplate[];
}

export interface SchedulerMutationResult {
  ok: boolean;
  message: string;
}

// Skills
export interface SkillRequirements {
  binaries: string[];
  env: string[];
  config: string[];
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  category?: string;
  relativePath: string;
  source: string;
  always: boolean;
  requires: SkillRequirements;
  content: string;
  size: number;
}

export interface SkillSkipRecord {
  kind: string;
  name: string;
  relativePath: string;
  source: string;
  reason: string;
  details?: string[];
}

export interface SkillDirectorySpec {
  relativePath: string;
  source: string;
}

export interface SkillSnapshot {
  generatedAt: string;
  signature: string;
  configEnabled: boolean;
  budget: { maxSkills: number; maxChars: number };
  directories: SkillDirectorySpec[];
  scannedFiles: number;
  loadedSkills: number;
  includedSkills: SkillEntry[];
  promptXml: string;
  skipped: SkillSkipRecord[];
}

export interface ManagedSkill {
  name: string;
  description: string;
  category: string;
  version: number;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSkillsData {
  snapshot: SkillSnapshot;
  managed: ManagedSkill[];
  disabledSkills: string[];
}

// Confirmations
export type ConfirmationDecision = 'approve' | 'deny' | 'modify';

export interface ConfirmationQueueEntry {
  id: string;
  method: string;
  action: string;
  scope: string;
  params: Record<string, unknown>;
  companionReason: string;
  requestedAt: number;
  expiresAt: number;
}

export interface AdminConfirmationsData {
  entries: ConfirmationQueueEntry[];
  available: boolean;
  message?: string;
}

export interface ConfirmationResolveResult {
  ok: boolean;
  message?: string;
}

// Values Timeline
export interface ValuesJournalEntry {
  id: string;
  version: number;
  templateId: string;
  templateName: string;
  prompt: string;
  reflection: string;
  createdAt: string;
}

export interface AdminValuesData {
  entries: ValuesJournalEntry[];
}

// Telemetry
export interface TelemetryEvent {
  type: string;
  timestamp: number;
  data: unknown;
}

// Audit Trail (derived from telemetry events on the client)
export type AuditActionType = 'tool_invocation' | 'identity_edit' | 'external_action' | 'memory_mutation';
export type AuditDecision = 'allowed' | 'denied';
export type AuditTimeRange = '15m' | '1h' | '24h' | '7d' | '30d' | 'all';

export interface AuditEntry {
  id: string;
  timestamp: number;
  actionType: AuditActionType;
  decision: AuditDecision;
  narrative: string;
  details?: string;
}

export interface AuditFilters {
  actionType: AuditActionType | 'all';
  decision: AuditDecision | 'all';
  timeRange: AuditTimeRange;
}
