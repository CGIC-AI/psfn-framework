import { createHash } from 'node:crypto';

import {
  SENSITIVITY_LEVELS,
  sensitivityAtMost,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import type {
  AutomataBusProvenance,
  AutomataBusVerificationStatus,
} from './contract.js';
import type { AutomataBusAudience } from './postgres-store.js';
import { createAutomataPositiveIntegerValidator } from '../validation.js';

type AutomataLessonEvidenceQuality =
  | 'none'
  | 'rejected'
  | 'unverified'
  | 'verified';

/**
 * Content-safe metadata emitted by the finding ingestion/review boundary.
 * Claims, evidence summaries, transcript spans, and raw artifacts deliberately
 * cannot be represented here.
 */
export interface AutomataLessonSourceFinding {
  companionId: string;
  eventId: string;
  automatonClass: string;
  promptRevision: string;
  toolName: string;
  failureCategory: string;
  lessonCode: string;
  provenance: AutomataBusProvenance;
  verificationStatus: AutomataBusVerificationStatus;
  evidenceRefs: readonly string[];
  audiences: readonly AutomataBusAudience[];
  sensitivity: SensitivityLevel;
  contradictionEventIds: readonly string[];
}

export interface AutomataLessonReadScope {
  companionId: string;
  audience: 'operator';
  maxSensitivity: SensitivityLevel;
}

export interface AutomataLessonProjectionPolicy {
  maxGroups: number;
  maxSourcesPerGroup: number;
}

export interface AutomataLessonGroup {
  groupId: string;
  automatonClass: string;
  promptRevision: string;
  toolName: string;
  failureCategory: string;
  lessonCode: string;
  sourceCount: number;
  support: 'low-support' | 'supported';
  evidenceQuality: AutomataLessonEvidenceQuality;
  sourceFindingIds: string[];
  evidenceIds: string[];
  sourceTraceTruncated: boolean;
  contradiction: {
    present: boolean;
    sourceFindingIds: string[];
  };
  inferenceOnly: boolean;
  /** Prevents downstream callers from presenting a model-derived cluster as fact. */
  interpretation: 'candidate-pattern-not-verified-defect';
}

export interface AutomataLessonProjection {
  groups: AutomataLessonGroup[];
  hasMore: boolean;
  sourceFindingCount: number;
}

export interface AutomataLessonSourcePort {
  listCurrent(scope: AutomataLessonReadScope): Promise<readonly AutomataLessonSourceFinding[]>;
}

const SAFE_DIMENSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u;

const positiveInteger = createAutomataPositiveIntegerValidator('Automata lesson');

function normalizePolicy(policy: AutomataLessonProjectionPolicy): AutomataLessonProjectionPolicy {
  return Object.freeze({
    maxGroups: positiveInteger(policy.maxGroups, 'maxGroups'),
    maxSourcesPerGroup: positiveInteger(policy.maxSourcesPerGroup, 'maxSourcesPerGroup'),
  });
}

function safeDimension(value: string, field: string): string {
  const normalized = value.trim();
  if (!SAFE_DIMENSION_PATTERN.test(normalized)) {
    throw new Error(`Automata lesson ${field} must be a content-safe identifier`);
  }
  return normalized;
}

function digestId(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function groupId(parts: readonly string[]): string {
  return `automata-lesson:v1:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function evidenceQualityOf(finding: AutomataLessonSourceFinding): AutomataLessonEvidenceQuality {
  if (finding.evidenceRefs.length === 0) return 'none';
  if (finding.verificationStatus === 'verified') return 'verified';
  if (finding.verificationStatus === 'rejected') return 'rejected';
  return 'unverified';
}

function normalizeScope(
  findings: readonly AutomataLessonSourceFinding[],
  scope: AutomataLessonReadScope | undefined,
): AutomataLessonReadScope {
  const companionId = safeDimension(
    scope?.companionId ?? findings[0]?.companionId ?? 'empty-companion',
    'scope.companionId',
  );
  const maxSensitivity = scope?.maxSensitivity ?? 'confidential';
  if (!SENSITIVITY_LEVELS.includes(maxSensitivity)) {
    throw new Error('Automata lesson scope maxSensitivity is invalid');
  }
  return { companionId, audience: 'operator', maxSensitivity };
}

function assertWithinScope(
  finding: AutomataLessonSourceFinding,
  scope: AutomataLessonReadScope,
): void {
  if (safeDimension(finding.companionId, 'companionId') !== scope.companionId) {
    throw new Error('Automata lesson source returned a cross-companion finding');
  }
  if (!finding.audiences.includes(scope.audience)) {
    throw new Error('Automata lesson source returned a finding outside the requested audience');
  }
  if (!sensitivityAtMost(finding.sensitivity, scope.maxSensitivity)) {
    throw new Error('Automata lesson source returned a finding outside the requested sensitivity');
  }
}

/** Rebuilds the read model solely from correction-aware current source rows. */
export function projectAutomataLessons(
  sourceFindings: readonly AutomataLessonSourceFinding[],
  policyInput: AutomataLessonProjectionPolicy,
  scopeInput?: AutomataLessonReadScope,
): AutomataLessonProjection {
  const policy = normalizePolicy(policyInput);
  const scope = normalizeScope(sourceFindings, scopeInput);
  const grouped = new Map<string, {
    dimensions: readonly [string, string, string, string, string, AutomataLessonEvidenceQuality];
    findings: AutomataLessonSourceFinding[];
  }>();
  const eventIds = new Set<string>();

  for (const finding of sourceFindings) {
    assertWithinScope(finding, scope);
    const eventId = safeDimension(finding.eventId, 'eventId');
    if (eventIds.has(eventId)) throw new Error(`Automata lesson source returned duplicate eventId "${eventId}"`);
    eventIds.add(eventId);
    const dimensions = [
      safeDimension(finding.promptRevision, 'promptRevision'),
      safeDimension(finding.automatonClass, 'automatonClass'),
      safeDimension(finding.toolName, 'toolName'),
      safeDimension(finding.failureCategory, 'failureCategory'),
      safeDimension(finding.lessonCode, 'lessonCode'),
      evidenceQualityOf(finding),
    ] as const;
    finding.evidenceRefs.forEach((reference, index) => {
      if (typeof reference !== 'string' || reference.length === 0) {
        throw new Error(`Automata lesson evidenceRefs[${index}] must be non-empty`);
      }
    });
    finding.contradictionEventIds.forEach((contradictionId, index) => {
      safeDimension(contradictionId, `contradictionEventIds[${index}]`);
    });
    const key = JSON.stringify(dimensions);
    const entry = grouped.get(key) ?? { dimensions, findings: [] };
    entry.findings.push(finding);
    grouped.set(key, entry);
  }

  const allGroups = [...grouped.values()].map(({ dimensions, findings }) => {
    const [
      promptRevision,
      automatonClass,
      toolName,
      failureCategory,
      lessonCode,
      evidenceQuality,
    ] = dimensions;
    const sourceFindingIds = findings.map(finding => finding.eventId).sort();
    const evidenceIds = [...new Set(findings.flatMap(finding => finding.evidenceRefs.map(digestId)))].sort();
    const contradictionIds = [...new Set(
      findings.flatMap(finding => finding.contradictionEventIds),
    )].sort();
    return {
      groupId: groupId(dimensions),
      promptRevision,
      automatonClass,
      toolName,
      failureCategory,
      lessonCode,
      sourceCount: findings.length,
      support: findings.at(1) === undefined ? 'low-support' : 'supported',
      evidenceQuality,
      sourceFindingIds: sourceFindingIds.slice(0, policy.maxSourcesPerGroup),
      evidenceIds: evidenceIds.slice(0, policy.maxSourcesPerGroup),
      sourceTraceTruncated: sourceFindingIds.length > policy.maxSourcesPerGroup
        || evidenceIds.length > policy.maxSourcesPerGroup,
      contradiction: {
        present: contradictionIds.length > 0,
        sourceFindingIds: contradictionIds.slice(0, policy.maxSourcesPerGroup),
      },
      inferenceOnly: findings.every(finding => finding.verificationStatus !== 'verified'),
      interpretation: 'candidate-pattern-not-verified-defect',
    } satisfies AutomataLessonGroup;
  }).sort((left, right) => (
    right.sourceCount - left.sourceCount || left.groupId.localeCompare(right.groupId)
  ));

  return {
    groups: allGroups.slice(0, policy.maxGroups),
    hasMore: allGroups.length > policy.maxGroups,
    sourceFindingCount: sourceFindings.length,
  };
}

export class AutomataLessonProjectionService {
  private readonly policy: AutomataLessonProjectionPolicy;

  constructor(private readonly options: {
    source: AutomataLessonSourcePort;
    policy: AutomataLessonProjectionPolicy;
  }) {
    this.policy = normalizePolicy(options.policy);
  }

  async query(scope: AutomataLessonReadScope): Promise<AutomataLessonProjection> {
    const normalizedScope = normalizeScope([], scope);
    const current = await this.options.source.listCurrent(normalizedScope);
    return projectAutomataLessons(current, this.policy, normalizedScope);
  }
}
