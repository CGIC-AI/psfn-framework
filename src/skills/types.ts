export type SkillSource = 'purrsephone' | 'bundled' | 'extra' | 'custom';

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

export interface SkillFileCandidate {
  absolutePath: string;
  relativePath: string;
  directory: SkillDirectorySpec;
  mtimeMs: number;
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
  content: string;
  absolutePath: string;
  relativePath: string;
  source: SkillSource;
  precedence: number;
  mtimeMs: number;
  size: number;
}

export type SkillSkipKind = 'parse_error' | 'shadowed' | 'ineligible' | 'budget';

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
  scannedFiles: number;
  loadedSkills: number;
  includedSkills: SkillEntry[];
  promptXml: string;
  skipped: SkillSkipRecord[];
}

export interface SkillLookupResult {
  entry: SkillEntry;
  eligible: SkillEligibilityResult;
}
