// Dashboard
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
    activeSessionContextPressure: DashboardSessionContextPressure;
    estimatedCostUsd: number;
    costWindows: {
      selected: DashboardCostWindow;
      byWindow: DashboardCostWindowTotals;
    };
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
  scopeRef?: MemoryScopeRef;
  scopeTags?: string[];
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

export interface MemoryScopeRef {
  kind: string;
  id: string;
  label?: string;
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
  scopeAssignments: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
}

export interface AdminMemorySearchResult {
  query: string;
  results: PurrMemory[];
  contactsById: Record<string, AdminMemoryContactSummary>;
}

export interface AdminMemoryLink {
  id1: string;
  id2: string;
  linkType: string;
  linkedAt: number;
}

export interface AdminMemoryLinkResult {
  ok: boolean;
  message?: string;
  link?: AdminMemoryLink;
}

export interface AdminBulkMutationResult {
  ok: boolean;
  count: number;
  message?: string;
}

export interface AdminMemoryScopeEvidenceItem {
  type: string;
  value: string;
  detail: string;
}

export interface AdminMemoryScopeAssignmentView {
  kind: 'project' | 'north_star';
  id: string;
  label?: string;
  canonicalTag: string;
  evidence: AdminMemoryScopeEvidenceItem[];
}

export interface AdminMemoryScopeRepairView {
  needsRepair: boolean;
  suggestedScopeRef?: MemoryScopeRef;
  suggestedScopeTags: string[];
  notes: string[];
}

export interface AdminMemoryScopeSummary {
  kind: 'project' | 'north_star';
  id: string;
  label?: string;
  canonicalTag: string;
  memoryCount: number;
  needsRepairCount: number;
}

export interface AdminMemoryScopedMemoryView {
  memory: PurrMemory;
  evidence: AdminMemoryScopeEvidenceItem[];
  repair: AdminMemoryScopeRepairView;
}

export interface AdminMemoryScopeListData {
  scopes: AdminMemoryScopeSummary[];
}

export interface AdminMemoryScopeDetailData {
  scope: AdminMemoryScopeSummary;
  memories: AdminMemoryScopedMemoryView[];
}

export interface AdminMemoryScopeMutationResult {
  ok: boolean;
  message?: string;
  memory?: PurrMemory;
  scopeAssignments?: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
}

// Sessions
export interface ChannelInfo {
  sessionId: string;
  channelId: string;
  messageCount: number;
  lastActivityAt?: number;
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

export interface AdminTurnStageTelemetry {
  observedAt: number;
  turnId: string;
  requestId?: string;
  channelId: string;
  callType?: string;
  purpose?: string;
  stage: string;
  elapsedMs: number;
  data: Record<string, unknown>;
}

export interface AdminTurnRetrievalTelemetry {
  observedAt: number;
  turnId: string;
  requestId?: string;
  channelId: string;
  callType?: string;
  purpose?: string;
  count: number;
  reason?: string;
  retrievalSource?: 'embedding' | 'lexical_fallback';
  data: Record<string, unknown>;
}

export interface MemoryWithheldSummary {
  totalCount: number;
  reasonCounts: Record<string, number>;
}

export interface AdminObservedMemory {
  id: string;
  text: string;
  type: string;
  importance: number;
  confidence: number;
  emotionalValence: number;
  formationVAD?: Record<string, number>;
  salience: number;
  sourceRef: string;
  extractedAt: number;
  lastAccessed: number;
  accessCount: number;
  supersededBy?: string;
  tags: string[];
  provenanceRefs?: string[];
  retentionClass?: string;
  sensitivity: string;
  consentFlags?: Record<string, boolean>;
  contactId?: string;
  deletedAt?: number;
  deletedBy?: string;
  deleteReason?: string;
}

export interface AdminObservedScoredMemory extends AdminObservedMemory {
  similarity: number;
}

export interface AdminTurnPromptSnapshotData {
  staticPrefixTemplate: string;
  dynamicSuffixTemplate: string;
  staticHash: string;
  versionPointer: string;
  sectionCacheability?: AdminPromptSectionCacheability[];
}

export type AdminPromptCacheabilityClass = 'static' | 'session_stable' | 'append_only' | 'volatile';

export type AdminPromptCacheBreaker =
  | 'prompt_layer'
  | 'macro'
  | 'runtime'
  | 'channel'
  | 'task'
  | 'tool'
  | 'retrieval'
  | 'scratchpad'
  | 'session_history';

export type AdminPromptSectionKey =
  | 'staticPrefixTemplate'
  | 'dynamicSuffixTemplate'
  | 'renderedStaticPrefix'
  | 'renderedDynamicSuffix'
  | 'runtimeContext'
  | 'memoryContextBlock'
  | 'scratchpadContext'
  | 'assembledPrompt'
  | 'finalSystemPrompt'
  | 'messages';

export interface AdminPromptSectionCacheability {
  section: AdminPromptSectionKey;
  cacheability: AdminPromptCacheabilityClass;
  cacheBreakers: AdminPromptCacheBreaker[];
  reason: string;
}

export interface AdminTurnPromptContextMessage {
  role: string;
  content: string;
}

export interface AdminTurnPromptContextSnapshotData {
  renderedStaticPrefix: string;
  renderedDynamicSuffix: string;
  runtimeContext: string;
  memoryContextBlock: string;
  scratchpadContext: string;
  assembledPrompt: string;
  finalSystemPrompt: string;
  messages: AdminTurnPromptContextMessage[];
  sectionCacheability?: AdminPromptSectionCacheability[];
}

export interface AdminTurnToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AdminAdaptiveToolSnapshotTool {
  toolName: string;
  source: string;
}

export interface AdminAdaptiveToolSnapshotSkip {
  toolName: string;
  source: string;
  reason: string;
  missingTokens?: string[];
}

export interface AdminAdaptiveToolSnapshotCounts {
  core: number;
  promoted: number;
  extendedLoaded: number;
  autoload: number;
  deferred: number;
  total: number;
}

export interface AdminAdaptiveToolSnapshotData {
  timestamp: number;
  tools: AdminAdaptiveToolSnapshotTool[];
  skipped: AdminAdaptiveToolSnapshotSkip[];
  counts: AdminAdaptiveToolSnapshotCounts;
  taskKind?: string | null;
  intent?: string | null;
  turnId?: string;
  requestId?: string;
  channelId?: string;
  callType?: string;
  purpose?: string;
}

export interface AdminTurnToolContextSnapshotData {
  activeTools: AdminTurnToolSchema[];
  adaptiveSnapshot?: AdminAdaptiveToolSnapshotData;
}

export interface AdminTurnSessionContextSnapshotData {
  channelId: string;
  recentEntries: SessionEntry[];
  compactionSummaryTexts: string[];
  focusKnowledgeTexts: string[];
  continuityEntries: SessionEntry[];
  compactionPromptText?: string;
  versionPointer: string;
}

export interface AdminTurnMemorySnapshotData {
  channelId: string;
  profile?: Record<string, unknown>;
  emotionalSnapshot?: Record<string, number>;
  contactEmotionalMemories: AdminObservedMemory[];
  semanticCandidates: AdminObservedScoredMemory[];
  lexicalCandidates: AdminObservedScoredMemory[];
  proactiveCandidates: AdminObservedMemory[];
  withheldSummary?: MemoryWithheldSummary;
  versionPointer: string;
}

export interface AdminTurnSnapshotData {
  turnId: string;
  requestId: string;
  channelId: string;
  capturedAt: number;
  trustLevel: string;
  canonicalContactKey?: string;
  prompt?: AdminTurnPromptSnapshotData;
  promptContext?: AdminTurnPromptContextSnapshotData;
  toolContext?: AdminTurnToolContextSnapshotData;
  sessionContext?: AdminTurnSessionContextSnapshotData;
  memory?: AdminTurnMemorySnapshotData;
}

export interface AdminSessionTurnData {
  record: {
    turnId: string;
    requestId: string;
    channelId: string;
    channelType: string;
    startedAt: number;
    completedAt: number;
    status: string;
    userMessage: SessionEntry;
    assistantMessage?: SessionEntry;
    toolCalls: Array<Record<string, unknown>>;
    contextManifestRef?: string;
    internalStateSnapshotRef?: string;
    extractedMemoryIds: string[];
    concernDeltaRefs: string[];
    contactDeltaRefs: string[];
    roleEnvelopeRefs?: string[];
    versionPointers: Record<string, unknown>;
    provenanceRefs: string[];
  };
  roleEnvelopeRefs: string[];
  stages: AdminTurnStageTelemetry[];
  retrievals: AdminTurnRetrievalTelemetry[];
  snapshot: AdminTurnSnapshotData | null;
}

export interface SessionRoleEnvelopePreview {
  schemaVersion: 1;
  envelopeId: string;
  internalRole: string;
  summary: string;
  sourceStage: string;
  promotionTarget: string;
  promotedRef?: string;
}

export interface AdminSessionRoleEnvelopePreview {
  sessionEntryId: number;
  preview: SessionRoleEnvelopePreview;
}

export interface AdminSessionContinuityArtifact {
  id: string;
  sessionId: string;
  kind: 'checkpoint' | 'wake_return';
  summary: string;
  createdAt: string;
  nextAnchor?: string;
  facets: Array<'task' | 'relational' | 'life'>;
  occasion?: 'wake' | 'return';
}

export interface AdminSessionMessagesData {
  sessionId: string;
  channelId: string;
  messages: SessionEntry[];
  continuityArtifacts: AdminSessionContinuityArtifact[];
  roleEnvelopePreviews: AdminSessionRoleEnvelopePreview[];
  compactionAuditViews: CompactionAuditView[];
  turns: AdminSessionTurnData[];
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
  conversationChannels?: Array<{
    channel: string;
    channelId: string;
    privacyLevel?: ChannelPrivacyLevel;
    firstSeen: string;
    lastSeen: string;
  }>;
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
  channelId: string;
  userId?: string;
  privacyLevel?: ChannelPrivacyLevel;
  lastSeen?: string;
}

export type SocialGraphEntitySource = 'contact' | 'memory' | 'manual' | 'system';
export type SocialRelationshipKind =
  | 'partner'
  | 'family'
  | 'friend'
  | 'acquaintance'
  | 'colleague'
  | 'parent'
  | 'child'
  | 'sibling'
  | 'caregiver'
  | 'household'
  | 'manager'
  | 'direct_report'
  | 'other';

export interface AdminContactSocialGraphEntityView {
  id: string;
  displayName: string;
  contactId?: string;
  source: SocialGraphEntitySource;
  sensitivity: string;
  confidence: number;
  provenanceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminContactSocialGraphNeighborView {
  entityId: string;
  contactId?: string;
  displayName: string;
  source: SocialGraphEntitySource;
  sensitivity: string;
  confidence: number;
  provenanceRefs: string[];
  mentionOnly: boolean;
  trustLevel?: TrustLevel;
  relationshipType?: RelationshipType;
  profileSummary?: string;
  profileUpdatedAt?: number;
}

export interface AdminContactSocialGraphConnectionView {
  edgeId: string;
  relationshipType: SocialRelationshipKind;
  directional: boolean;
  direction: 'incoming' | 'outgoing' | 'undirected';
  sensitivity: string;
  confidence: number;
  provenanceRefs: string[];
  evidenceMemoryIds: string[];
  createdAt: string;
  updatedAt: string;
  neighbor: AdminContactSocialGraphNeighborView;
}

export interface AdminContactSocialGraphView {
  entity?: AdminContactSocialGraphEntityView;
  edgeCount: number;
  neighborCount: number;
  evidenceCount: number;
  provenanceCount: number;
  mentionOnlyNeighborCount: number;
  connections: AdminContactSocialGraphConnectionView[];
}

export interface AdminContactListData {
  contacts: Contact[];
  profileMap: Record<string, ContactProfileArtifact>;
  relatedChannelMap: Record<string, ContactConversationChannelView[]>;
  socialGraphMap: Record<string, AdminContactSocialGraphView>;
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
export interface SettingsContractSubsystem {
  id: string;
  ownerFile: string;
  mode: 'structured' | 'raw_only';
}

export interface SettingsContractField {
  key: string;
  ownerSubsystem: string;
  ownerFile: string;
  type: 'string' | 'boolean' | 'integer' | 'number' | 'string_array' | 'enum' | 'object';
  minimum?: number;
  maximum?: number;
  enumValues?: string[];
  deprecated?: boolean;
}

export interface SettingsContractData {
  schemaVersion: number;
  subsystems: Record<string, SettingsContractSubsystem>;
  fields: Record<string, SettingsContractField>;
}

export type CanonicalProviderType =
  | 'litellm_proxy'
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'mistral'
  | 'generic_openai';

export interface ProviderRegistryEntry {
  id: string;
  type: CanonicalProviderType;
  enabled: boolean;
  label?: string;
  apiBaseUrl?: string;
  modelsApiUrl?: string;
  apiKeyEnv?: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalProviderRegistry {
  schemaVersion: 1;
  providers: ProviderRegistryEntry[];
}

export interface ProvidersRuntimeConfig {
  registry: CanonicalProviderRegistry;
  litellmBaseUrl?: string;
  litellmApiKeyEnv?: string;
  openRouterApiBaseUrl?: string;
  openRouterModelsApiUrl?: string;
  openRouterApiKeyEnv?: string;
}

export interface AdminSettingsData {
  config: Record<string, unknown>;
  env: Record<string, unknown>;
  editors: {
    models: unknown;
    providers: ProvidersRuntimeConfig;
    skills: unknown;
    scheduler: unknown;
    trustPolicy: unknown;
    capabilities: unknown;
    backup: unknown;
  };
  voiceProviders: {
    stt: Array<{
      id: string;
      configured: boolean;
      requiredTokens: string[];
    }>;
    tts: Array<{
      id: string;
      configured: boolean;
      requiredTokens: string[];
    }>;
  };
}

export interface ConfigUpdateResult {
  ok: boolean;
  message: string;
  validationErrors?: Array<{
    field: string;
    message: string;
    code?: string;
  }>;
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

export interface ConstitutionImmutableBlock {
  id: string;
  title: string;
  content: string;
  editable: false;
}

export interface ConstitutionCompanionLayer {
  id: string;
  title: string;
  content: string;
  provenanceRefs: string[];
  historyVersions: number[];
  entryIds: string[];
  editable: false;
}

export interface ConstitutionMutableLayer extends PromptLayer {
  editable: boolean;
  readOnlyReason?: string;
}

export interface ConstitutionSnapshotData {
  immutableBlocks: ConstitutionImmutableBlock[];
  companionLayer: ConstitutionCompanionLayer | null;
  mutableLayers: ConstitutionMutableLayer[];
  preview: {
    text: string;
    hash: string;
    staticPrefix: string;
    dynamicSuffix: string;
  };
}

export interface ConstitutionUpdateResult {
  ok: boolean;
  message: string;
  snapshot?: ConstitutionSnapshotData;
}

export type NorthStarScope = 'shared' | 'companion';

export interface NorthStarItem {
  id: string;
  title: string;
  content: string;
  scope: NorthStarScope;
  enabled: boolean;
  priority: number;
  updatedAt: string;
  updatedBy: string;
  checksum: string;
  version: number;
}

export interface NorthStarSnapshotData {
  items: NorthStarItem[];
  limit: number;
  preview: {
    text: string;
    hash: string;
  };
}

export interface NorthStarUpdateResult {
  ok: boolean;
  message: string;
  snapshot?: NorthStarSnapshotData;
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
      targetKind: 'identity' | 'conversation';
      channel: string;
      userId?: string;
      channelId?: string;
      privacyLevel: string;
    }>;
  }>;
  assistantName: string;
  canonicalContactId: string;
  displayName: string;
  nickname?: string;
  linkedChannels: Array<{
    targetKind: 'identity' | 'conversation';
    channel: string;
    userId?: string;
    channelId?: string;
    privacyLevel: string;
  }>;
  selectedTarget: {
    canonicalContactId: string;
    targetKind: 'identity' | 'conversation';
    channel: string;
    userId?: string;
    channelId?: string;
    privacyLevel: string;
    sessionId: string;
  };
  privacy: {
    availableLevels: string[];
    selectedLevel: string;
  };
  onboarding: {
    required: boolean;
    message?: string;
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
  companion: {
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
  providerHints?: string[];
  contextLength?: number;
  maxCompletionTokens?: number;
  pricing?: Record<string, string | number | undefined>;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
}

// Scheduler
export type TaskType = 'every' | 'one-shot';
export type TaskState = 'idle' | 'active' | 'paused' | 'complete';
export type SchedulerCadenceTimezone = 'local' | 'utc';

export interface RelativeRecurringCadence {
  kind: 'relative';
}

export interface HourlyRecurringCadence {
  kind: 'hourly';
  minute: number;
  timezone: SchedulerCadenceTimezone;
}

export interface DailyRecurringCadence {
  kind: 'daily';
  hour: number;
  minute: number;
  timezone: SchedulerCadenceTimezone;
}

export type RecurringCadence =
  | RelativeRecurringCadence
  | HourlyRecurringCadence
  | DailyRecurringCadence;

export interface ScheduledTask {
  id: string;
  name: string;
  type: TaskType;
  intervalMs: number;
  cadence?: RecurringCadence;
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
  cadence?: RecurringCadence;
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
export interface TelemetryCorrelation {
  turnId?: string;
  requestId?: string;
  channelId?: string;
  callType?: string;
  originType?: string;
  originStage?: string;
  toolName?: string;
  toolCallId?: string;
  purpose?: string;
}

export interface TelemetryEvent {
  type: string;
  timestamp: number;
  correlation?: TelemetryCorrelation;
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
