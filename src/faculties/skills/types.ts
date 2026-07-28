export type SkillSource = 'bundled' | 'extra' | 'custom';
export type SkillOwnership = 'personal' | 'deployment';
export type SkillInvocationOutcome = 'success' | 'failure';

export interface ManagedSkillOwnership {
  owner: 'personal';
  managedRoot: string;
  configPath: string;
}

export interface SkillRequirementSpec {
  binaries: string[];
  env: string[];
  config: string[];
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  category?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  always: boolean;
  requires: SkillRequirementSpec;
  raw: Record<string, unknown>;
}

export interface SkillDirectorySpec {
  absolutePath: string;
  relativePath: string;
  source: SkillSource;
  precedence: number;
}

/**
 * Scan provenance for a single skills root: whether the directory was
 * actually present at scan time and how many SKILL.md files it contributed.
 * `exists` is true only when the path is an existing directory.
 */
export interface SkillRootScan {
  path: string;
  absolutePath: string;
  exists: boolean;
  skillCount: number;
  source: SkillSource;
  precedence: number;
  /** Per-root degradation detail. Present when a non-managed root is unusable. */
  message?: string;
}

export interface SkillFileCandidate {
  absolutePath: string;
  relativePath: string;
  directory: SkillDirectorySpec;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  category?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  always: boolean;
  requires: SkillRequirementSpec;
  absolutePath: string;
  relativePath: string;
  source: SkillSource;
  precedence: number;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
}

export type SkillSkipKind = 'parse_error' | 'oversized' | 'collection_limit' | 'shadowed' | 'ineligible' | 'budget';

export interface SkillSkipRecord {
  kind: SkillSkipKind;
  name: string;
  relativePath: string;
  source: SkillSource;
  reason: string;
  details?: string[];
}

export interface SkillBudget {
  maxSkills: number;
  maxChars: number;
}

export interface SkillCollectionLimits {
  maxDiscoveryEntries: number;
  maxCandidates: number;
  maxMetadataBytes: number;
  maxRetainedBytes: number;
  maxContentBytes: number;
  yieldEvery: number;
}

export interface SkillCollectionStats {
  discoveryEntries: number;
  candidatesSeen: number;
  candidateBytesRetained: number;
  metadataBytesRead: number;
  metadataBytesRetained: number;
  limited: boolean;
  limits: SkillCollectionLimits;
}

export interface SkillEligibilityResult {
  eligible: boolean;
  disabledByConfig: boolean;
  missingBinaries: string[];
  missingEnv: string[];
  missingConfig: string[];
  reasons: string[];
}

export interface SkillEvaluation {
  entry: SkillEntry;
  eligibility: SkillEligibilityResult;
}

export interface SkillFormatResult {
  xml: string;
  included: SkillEntry[];
  excluded: SkillSkipRecord[];
  totalChars: number;
}

export interface SkillSnapshot {
  generatedAt: string;
  signature: string;
  configEnabled: boolean;
  budget: SkillBudget;
  directories: SkillDirectorySpec[];
  roots: SkillRootScan[];
  scannedFiles: number;
  loadedSkills: number;
  collection: SkillCollectionStats;
  includedSkills: SkillEntry[];
  promptXml: string;
  skipped: SkillSkipRecord[];
}

export interface SkillLookupResult {
  entry: SkillEntry;
  eligible: SkillEligibilityResult;
}

export interface SkillInvocationRecordInput {
  outcome: SkillInvocationOutcome;
  durationMs?: number;
  occurredAt?: Date | string;
}

export interface SkillUsageStats {
  name: string;
  firstUsedAt: string;
  lastUsedAt: string;
  invocationCount: number;
  successCount: number;
  failureCount: number;
  durationSampleCount: number;
  averageDurationMs: number | null;
  lastDurationMs: number | null;
  lastOutcome: SkillInvocationOutcome;
  successRate: number | null;
}
