import { createHash } from 'node:crypto';
import {
  SENSITIVITY_LEVELS,
  sensitivityOrd,
  type SensitivityLevel,
} from '../../system/trust/types.js';
import { isRecord } from '../utils/types.js';

export const ARTIFACT_SENSITIVITY_SCHEMA_VERSION = 1;

export interface ArtifactSensitivitySource {
  /** Content-free durable provenance reference, such as `memory:<id>`. */
  ref: string;
  sensitivity: SensitivityLevel;
}

export interface ArtifactSensitivityContest {
  actor: 'companion' | 'operator' | 'subject';
  previousSensitivity: SensitivityLevel;
  sensitivity: SensitivityLevel;
  reason: string;
  contestedAt: string;
}

export interface ArtifactSensitivityClassification {
  schemaVersion: typeof ARTIFACT_SENSITIVITY_SCHEMA_VERSION;
  sensitivity: SensitivityLevel;
  basis: 'max_input_sensitivity' | 'contested';
  classifiedAt: string;
  sources: ArtifactSensitivitySource[];
  contests: ArtifactSensitivityContest[];
}

export function isSensitivityLevel(value: unknown): value is SensitivityLevel {
  return typeof value === 'string'
    && SENSITIVITY_LEVELS.some(level => level === value);
}

function normalizeSource(source: ArtifactSensitivitySource): ArtifactSensitivitySource | null {
  const ref = source.ref.trim();
  if (!ref || !isSensitivityLevel(source.sensitivity)) return null;
  return { ref, sensitivity: source.sensitivity };
}

export function classifyArtifactSensitivity(
  sources: readonly ArtifactSensitivitySource[],
  now: Date = new Date(),
): ArtifactSensitivityClassification {
  const byRef = new Map<string, ArtifactSensitivitySource>();
  for (const source of sources) {
    const normalized = normalizeSource(source);
    if (!normalized) continue;
    const existing = byRef.get(normalized.ref);
    if (!existing || sensitivityOrd(normalized.sensitivity) > sensitivityOrd(existing.sensitivity)) {
      byRef.set(normalized.ref, normalized);
    }
  }
  const normalizedSources = [...byRef.values()].sort((left, right) => left.ref.localeCompare(right.ref));
  const sensitivity = normalizedSources.reduce<SensitivityLevel>(
    (highest, source) => sensitivityOrd(source.sensitivity) > sensitivityOrd(highest)
      ? source.sensitivity
      : highest,
    'public',
  );
  return {
    schemaVersion: ARTIFACT_SENSITIVITY_SCHEMA_VERSION,
    sensitivity,
    basis: 'max_input_sensitivity',
    classifiedAt: now.toISOString(),
    sources: normalizedSources,
    contests: [],
  };
}

function parseSource(value: unknown): ArtifactSensitivitySource | null {
  if (!isRecord(value)) return null;
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  if (!ref || !isSensitivityLevel(value.sensitivity)) return null;
  return { ref, sensitivity: value.sensitivity };
}

function parseContest(value: unknown): ArtifactSensitivityContest | null {
  if (!isRecord(value)) return null;
  if (
    value.actor !== 'companion'
    && value.actor !== 'operator'
    && value.actor !== 'subject'
  ) return null;
  if (!isSensitivityLevel(value.previousSensitivity) || !isSensitivityLevel(value.sensitivity)) {
    return null;
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  const contestedAt = typeof value.contestedAt === 'string' ? value.contestedAt.trim() : '';
  if (!reason || !contestedAt || Number.isNaN(Date.parse(contestedAt))) return null;
  return {
    actor: value.actor,
    previousSensitivity: value.previousSensitivity,
    sensitivity: value.sensitivity,
    reason,
    contestedAt,
  };
}

export function parseArtifactSensitivityClassification(
  value: unknown,
): ArtifactSensitivityClassification | null {
  if (!isRecord(value) || value.schemaVersion !== ARTIFACT_SENSITIVITY_SCHEMA_VERSION) return null;
  if (!isSensitivityLevel(value.sensitivity)) return null;
  if (value.basis !== 'max_input_sensitivity' && value.basis !== 'contested') return null;
  const classifiedAt = typeof value.classifiedAt === 'string' ? value.classifiedAt.trim() : '';
  if (!classifiedAt || Number.isNaN(Date.parse(classifiedAt))) return null;
  if (!Array.isArray(value.sources) || !Array.isArray(value.contests)) return null;
  const sources = value.sources.map(parseSource);
  const contests = value.contests.map(parseContest);
  if (sources.some(source => source === null) || contests.some(contest => contest === null)) return null;
  const parsedSources = sources.filter((source): source is ArtifactSensitivitySource => source !== null);
  const parsedContests = contests.filter((contest): contest is ArtifactSensitivityContest => contest !== null);
  const inheritedSensitivity = parsedSources.reduce<SensitivityLevel>(
    (highest, source) => sensitivityOrd(source.sensitivity) > sensitivityOrd(highest)
      ? source.sensitivity
      : highest,
    'public',
  );
  if (value.basis === 'max_input_sensitivity') {
    if (parsedContests.length > 0 || value.sensitivity !== inheritedSensitivity) return null;
  } else {
    if (parsedContests.length === 0) return null;
    let previousSensitivity = inheritedSensitivity;
    for (const contest of parsedContests) {
      if (contest.previousSensitivity !== previousSensitivity) return null;
      previousSensitivity = contest.sensitivity;
    }
    if (value.sensitivity !== previousSensitivity) return null;
  }
  return {
    schemaVersion: ARTIFACT_SENSITIVITY_SCHEMA_VERSION,
    sensitivity: value.sensitivity,
    basis: value.basis,
    classifiedAt,
    sources: parsedSources,
    contests: parsedContests,
  };
}

export function contestArtifactSensitivity(
  classification: ArtifactSensitivityClassification,
  input: {
    actor: ArtifactSensitivityContest['actor'];
    sensitivity: SensitivityLevel;
    reason: string;
    now?: Date;
  },
): ArtifactSensitivityClassification {
  const reason = input.reason.trim();
  if (!reason) throw new Error('Artifact sensitivity contest requires a reason');
  const contestedAt = (input.now ?? new Date()).toISOString();
  return {
    ...classification,
    sensitivity: input.sensitivity,
    basis: 'contested',
    contests: [
      ...classification.contests,
      {
        actor: input.actor,
        previousSensitivity: classification.sensitivity,
        sensitivity: input.sensitivity,
        reason,
        contestedAt,
      },
    ],
  };
}

export function artifactSensitivityRequiresApproval(
  classification: ArtifactSensitivityClassification,
): boolean {
  return classification.sensitivity === 'intimate'
    || classification.sensitivity === 'confidential';
}

export function fingerprintArtifactSensitivity(
  classification: ArtifactSensitivityClassification,
): string {
  return createHash('sha256')
    .update(JSON.stringify(classification), 'utf8')
    .digest('hex');
}
