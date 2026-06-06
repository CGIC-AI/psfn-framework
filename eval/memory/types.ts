export const MEMORY_REGRESSION_SCHEMA_VERSION = 1 as const;

export type MemoryFixtureFamily =
  | 'current-state-change'
  | 'compatible-update'
  | 'true-contradiction'
  | 'episodic-overlap'
  | 'episodic-paraphrase'
  | 'privacy-trust'
  | 'withheld-context'
  | 'backup-restore-degradation';

export const REQUIRED_MEMORY_FIXTURE_FAMILIES: readonly MemoryFixtureFamily[] = [
  'current-state-change',
  'compatible-update',
  'true-contradiction',
  'episodic-overlap',
  'episodic-paraphrase',
  'privacy-trust',
  'withheld-context',
  'backup-restore-degradation',
];

export type MemoryLayer = 'L0' | 'L0.1' | 'L2';
export type MemorySensitivity = 'public' | 'personal' | 'private' | 'secret';
export type MemoryTrustLevel = 'untrusted' | 'regular' | 'trusted' | 'primary';

export interface L0FixtureEntry {
  layer: 'L0';
  id: string;
  sessionId: string;
  turnId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  trustLevel: MemoryTrustLevel;
  channelVisibility: 'direct' | 'private' | 'public';
}

export interface L01FixtureEpisode {
  layer: 'L0.1';
  id: string;
  threadId: string;
  channelId: string;
  startedAt: string;
  endedAt: string;
  summary: string;
  salientFacts: string[];
  eventKey: string;
  provenanceRefs: string[];
  trustLevel: MemoryTrustLevel;
}

export interface L2FixtureMemory {
  layer: 'L2';
  id: string;
  text: string;
  tags: string[];
  sensitivity: MemorySensitivity;
  sourceRefs: string[];
  createdAt: string;
  confidence: number;
  supersededBy?: string;
  retrievalPolicy?: {
    allowRecall: boolean;
    withheldReason: 'consent.withdrawn' | 'trust.ceiling_exceeded' | 'scope.withheld';
  };
}

export interface MemoryRegressionSeed {
  l0Entries: L0FixtureEntry[];
  l01Episodes: L01FixtureEpisode[];
  l2Memories: L2FixtureMemory[];
}

export interface MemoryWriteOperation {
  id: string;
  text: string;
  tags: string[];
  sensitivity: MemorySensitivity;
  sourceRef: string;
  timestamp: string;
  createsMemoryId: string;
  expectedSupersededMemoryIds: string[];
  compatibleUpdate?: boolean;
}

export interface MemoryRetrievalProbe {
  id: string;
  query: string;
  topK: number;
  trustLevel: MemoryTrustLevel;
  expectedMemoryIds: string[];
  expectedWithheldMemoryIds?: string[];
}

export interface MemoryMaintenanceQueueItem {
  id: string;
  enqueuedAt: string;
  processedAt: string;
}

export interface MemoryMaintenanceExpectation {
  expectedEpisodeMergeGroups?: string[][];
  queueItems?: MemoryMaintenanceQueueItem[];
}

export interface MemoryBackupRestoreExpectation {
  probeAfterRestore: MemoryRetrievalProbe;
}

export interface MemoryRegressionFixture {
  id: string;
  family: MemoryFixtureFamily;
  description: string;
  seed: MemoryRegressionSeed;
  writes: MemoryWriteOperation[];
  retrievals: MemoryRetrievalProbe[];
  maintenance?: MemoryMaintenanceExpectation;
  backupRestore?: MemoryBackupRestoreExpectation;
}

export interface MemoryWriteObservation {
  operationId: string;
  createdMemoryId: string;
  supersededMemoryIds: string[];
}

export interface MemoryRetrievalObservation {
  probeId: string;
  selectedMemoryIds: string[];
  withheldMemoryIds: string[];
  promptSnippet: string;
  promptTokenCount: number;
  latencyMs: number;
}

export interface MemoryMaintenanceObservation {
  fixtureId: string;
  mergedEpisodePairs: Array<[string, string]>;
  activeEpisodeIds: string[];
  queueAgeMs: number[];
}

export interface MemoryBackupSnapshot {
  l0Entries: L0FixtureEntry[];
  l01Episodes: L01FixtureEpisode[];
  l2Memories: L2FixtureMemory[];
}

export interface MemoryRegressionProvider {
  readonly id: string;
  seedFixture(fixture: MemoryRegressionFixture): Promise<void>;
  writeMemory(operation: MemoryWriteOperation): Promise<MemoryWriteObservation>;
  runMaintenance(fixture: MemoryRegressionFixture): Promise<MemoryMaintenanceObservation>;
  retrieve(probe: MemoryRetrievalProbe): Promise<MemoryRetrievalObservation>;
  backup(): Promise<MemoryBackupSnapshot>;
  restore(snapshot: MemoryBackupSnapshot): Promise<void>;
}

export type MemoryMetricName =
  | 'precision@k'
  | 'recall@k'
  | 'mrr'
  | 'false_supersede_rate'
  | 'missed_supersede_rate'
  | 'compatible_update_false_positive_rate'
  | 'episode_duplicate_rate'
  | 'merge_precision'
  | 'merge_recall'
  | 'trust_leak_rate'
  | 'useful_facts_per_prompt_token'
  | 'retrieval_latency_ms_p95'
  | 'queue_age_ms_max';

export type MemoryRegressionStatus = 'pass' | 'fail';

export interface MemoryMetricGate {
  metric: MemoryMetricName;
  operator: 'gte' | 'lte';
  threshold: number;
  actual: number;
  passed: boolean;
}

export interface MemoryRegressionFixtureResult {
  fixtureId: string;
  family: MemoryFixtureFamily;
  status: MemoryRegressionStatus;
  writes: MemoryWriteObservation[];
  retrievals: MemoryRetrievalObservation[];
  maintenance: MemoryMaintenanceObservation;
  failures: string[];
}

export interface MemoryRegressionReport {
  schemaVersion: typeof MEMORY_REGRESSION_SCHEMA_VERSION;
  artifactType: 'psfn.memory_regression_benchmark';
  providerId: string;
  generatedAt: string;
  status: MemoryRegressionStatus;
  k: number;
  fixtureCount: number;
  families: MemoryFixtureFamily[];
  metrics: Record<MemoryMetricName, number>;
  gates: MemoryMetricGate[];
  fixtureResults: MemoryRegressionFixtureResult[];
}
