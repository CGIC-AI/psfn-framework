import { isRecord } from '../../shared/utils/types.js';
import {
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../../system/trust/types.js';
import type { WikiDocument } from './types.js';

export type PersonalProjectStatus = 'active' | 'paused' | 'completed' | 'archived';
export type CompanionOwnedVisibility = 'self' | 'primary_contact' | 'public';
export type ProjectArtifactShareState = 'private' | 'requested' | 'shared';

/**
 * Provenance authority for an artifact's disclosure metadata (bible §6.2, §9.5).
 *
 * - `runtime_derived`: sensitivity/audience were resolved by the runtime at
 *   write time from the project's workspace disclosure floor (the only
 *   trustworthy source; see `addArtifact`). Eligible for the egress gate.
 * - `legacy_unverified`: the metadata predates runtime derivation (it was once
 *   model-asserted, or the artifact was written before this field existed).
 *   §9.5 forbids treating such artifacts as automatically shareable; they fail
 *   closed at egress until re-grounded in a fresh eligible context.
 */
export type ArtifactMetadataLineage = 'runtime_derived' | 'legacy_unverified';

export interface PersonalProjectArtifact {
  ref: string;
  label: string;
  sensitivity: SensitivityLevel;
  intendedAudience: CompanionOwnedVisibility;
  shareState: ProjectArtifactShareState;
  metadataLineage: ArtifactMetadataLineage;
  addedAt: string;
}

export interface PersonalProjectManifest {
  schemaVersion: 1;
  kind: 'personal_project';
  id: string;
  ref: string;
  title: string;
  status: PersonalProjectStatus;
  visibility: CompanionOwnedVisibility;
  nextStep: string;
  artifacts: PersonalProjectArtifact[];
  resumeCount: number;
  createdAt: string;
  updatedAt: string;
  lastResumedAt?: string;
}

export interface NamedWardrobeLook {
  schemaVersion: 1;
  kind: 'named_wardrobe_look';
  id: string;
  ref: string;
  name: string;
  promptFragment: string;
  visibility: CompanionOwnedVisibility;
  createdAt: string;
  updatedAt: string;
  supersedesRef?: string;
  supersededByRef?: string;
}

export interface ResolvedWardrobeLook {
  ref: string;
  name: string;
  promptFragment: string;
}

export function requiredProjectText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeProjectEntityId(value: unknown, field: string): string {
  const id = requiredProjectText(value, field).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(`${field} must contain only lowercase letters, digits, underscores, or hyphens`);
  }
  return id;
}

function isProjectStatus(value: unknown): value is PersonalProjectStatus {
  return value === 'active'
    || value === 'paused'
    || value === 'completed'
    || value === 'archived';
}

function isVisibility(value: unknown): value is CompanionOwnedVisibility {
  return value === 'self' || value === 'primary_contact' || value === 'public';
}

function isShareState(value: unknown): value is ProjectArtifactShareState {
  return value === 'private' || value === 'requested' || value === 'shared';
}

function isSensitivityLevel(value: unknown): value is SensitivityLevel {
  return typeof value === 'string' && SENSITIVITY_LEVELS.some(level => level === value);
}

/**
 * Resolves the disclosure-metadata provenance for a stored artifact, failing
 * closed (bible §9.5). Only the exact `runtime_derived` marker — written by the
 * runtime derivation path — grants egress eligibility. Anything else (absent on
 * pre-migration documents, or any unexpected value) resolves to
 * `legacy_unverified`, so an unclassified artifact is never automatically
 * shareable even before the one-time quarantine migration has run.
 */
function parseMetadataLineage(value: unknown): ArtifactMetadataLineage {
  return value === 'runtime_derived' ? 'runtime_derived' : 'legacy_unverified';
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function parseJsonBody(document: WikiDocument): unknown {
  try {
    return JSON.parse(document.body);
  } catch (error) {
    throw new Error(`wiki document ${document.id} has malformed structured project data`, { cause: error });
  }
}

function parseArtifact(value: unknown): PersonalProjectArtifact | null {
  if (!isRecord(value)) return null;
  if (!isSensitivityLevel(value.sensitivity) || !isVisibility(value.intendedAudience)) return null;
  if (!isShareState(value.shareState) || !isIsoTimestamp(value.addedAt)) return null;
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (!ref || !label) return null;
  return {
    ref,
    label,
    sensitivity: value.sensitivity,
    intendedAudience: value.intendedAudience,
    shareState: value.shareState,
    metadataLineage: parseMetadataLineage(value.metadataLineage),
    addedAt: value.addedAt,
  };
}

export function parsePersonalProjectDocument(document: WikiDocument): PersonalProjectManifest {
  if (document.sourceClass !== 'companion_authored_note' || (document.scope && document.scope !== 'personal')) {
    throw new Error(`wiki document ${document.id} is not companion-owned personal project data`);
  }
  const value = parseJsonBody(document);
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'personal_project') {
    throw new Error(`wiki document ${document.id} is not a personal project manifest`);
  }
  if (!isProjectStatus(value.status) || !isVisibility(value.visibility)) {
    throw new Error(`wiki document ${document.id} has invalid project state`);
  }
  if (!Array.isArray(value.artifacts)) {
    throw new Error(`wiki document ${document.id} has invalid project artifacts`);
  }
  const artifacts = value.artifacts.map(parseArtifact);
  if (artifacts.some(artifact => artifact === null)) {
    throw new Error(`wiki document ${document.id} has an invalid project artifact`);
  }
  if (typeof value.resumeCount !== 'number' || !Number.isInteger(value.resumeCount) || value.resumeCount < 0) {
    throw new Error(`wiki document ${document.id} has invalid resumeCount`);
  }
  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) {
    throw new Error(`wiki document ${document.id} has invalid project timestamps`);
  }
  if (value.lastResumedAt !== undefined && !isIsoTimestamp(value.lastResumedAt)) {
    throw new Error(`wiki document ${document.id} has invalid lastResumedAt`);
  }
  const id = normalizeProjectEntityId(value.id, 'project id');
  if (document.id !== `project.${id}`) throw new Error(`wiki document ${document.id} has mismatched project id`);
  const ref = requiredProjectText(value.ref, 'project ref');
  if (ref !== `project:${id}`) throw new Error(`wiki document ${document.id} has mismatched project ref`);
  return {
    schemaVersion: 1,
    kind: 'personal_project',
    id,
    ref,
    title: requiredProjectText(value.title, 'project title'),
    status: value.status,
    visibility: value.visibility,
    nextStep: requiredProjectText(value.nextStep, 'project nextStep'),
    artifacts: artifacts.filter((artifact): artifact is PersonalProjectArtifact => artifact !== null),
    resumeCount: value.resumeCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.lastResumedAt ? { lastResumedAt: value.lastResumedAt } : {}),
  };
}

export function parseNamedWardrobeLookDocument(document: WikiDocument): NamedWardrobeLook {
  if (document.sourceClass !== 'companion_authored_note' || (document.scope && document.scope !== 'personal')) {
    throw new Error(`wiki document ${document.id} is not companion-owned wardrobe data`);
  }
  const value = parseJsonBody(document);
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'named_wardrobe_look') {
    throw new Error(`wiki document ${document.id} is not a named wardrobe look`);
  }
  if (!isVisibility(value.visibility) || !isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) {
    throw new Error(`wiki document ${document.id} has invalid wardrobe state`);
  }
  const id = normalizeProjectEntityId(value.id, 'look id');
  if (document.id !== `wardrobe.look.${id}`) throw new Error(`wiki document ${document.id} has mismatched wardrobe id`);
  const ref = requiredProjectText(value.ref, 'look ref');
  if (ref !== `wardrobe:${id}`) throw new Error(`wiki document ${document.id} has mismatched wardrobe ref`);
  const supersedesRef = value.supersedesRef === undefined
    ? undefined
    : requiredProjectText(value.supersedesRef, 'look supersedesRef');
  const supersededByRef = value.supersededByRef === undefined
    ? undefined
    : requiredProjectText(value.supersededByRef, 'look supersededByRef');
  return {
    schemaVersion: 1,
    kind: 'named_wardrobe_look',
    id,
    ref,
    name: requiredProjectText(value.name, 'look name'),
    promptFragment: requiredProjectText(value.promptFragment, 'look promptFragment'),
    visibility: value.visibility,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(supersedesRef ? { supersedesRef } : {}),
    ...(supersededByRef ? { supersededByRef } : {}),
  };
}
