import { isRecord } from '../../shared/utils/types.js';
import {
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../../system/trust/types.js';
import type { WikiDocument } from './types.js';

export type PersonalProjectStatus = 'active' | 'paused' | 'completed' | 'archived';
export type CompanionOwnedVisibility = 'self' | 'primary_contact' | 'public';
export type ProjectArtifactShareState = 'private' | 'requested' | 'shared';

/** Publication/review mode for a publication work context (bible §10.9/§10.10). */
export type ProjectPublicationMode = 'public_clean' | 'expressive_review';

/**
 * The current personal-project manifest schema version. v1 manifests (which had
 * no durable work context) are read and upgraded to this version explicitly by
 * {@link parsePersonalProjectDocument} — never silently coerced.
 */
export const CURRENT_PROJECT_SCHEMA_VERSION = 2 as const;
export type ProjectSchemaVersion = 1 | typeof CURRENT_PROJECT_SCHEMA_VERSION;

/**
 * The DM return anchor for private, contact-anchored free-time work (bible
 * §10.6/§10.8). The manifest stores only the stable `contactId`; the concrete DM
 * `channelId` is resolved by the return-note routing at projection time.
 */
export interface ProjectContactDmTarget {
  contactId: string;
  channelId?: string;
}

/**
 * A project's durable, companion-owned work context (bible §10.3/§10.5). This is
 * the "per-directory privacy" classification of the directory-per-project
 * workspace model (adjudication S12.4). It is a companion CHOICE (private vs
 * room vs publication is her prerogative, §10.1) — but every disclosure-relevant
 * fact DERIVED from it (continuity session id, return policy, retrieval /
 * disclosure ceilings) is computed by the runtime, never asserted by the model
 * (bible §6.2). Structurally mirrors the resolver's `FreeTimeWorkspaceContext`;
 * the composition seam maps one to the other.
 */
export type PersonalProjectWorkContext =
  | { kind: 'private'; returnTarget?: ProjectContactDmTarget }
  | { kind: 'room'; channelId: string }
  | { kind: 'publication'; mode: ProjectPublicationMode; surfaceRef?: string };

/**
 * The default return policy for a project workspace (bible §10.8). RUNTIME-
 * DERIVED from the work context — {@link parsePersonalProjectDocument} always
 * recomputes it on read and never trusts a persisted value, so a forged or
 * drifted manifest cannot redirect where a return note lands.
 */
export type PersonalProjectReturnPolicy =
  | { kind: 'contact_dm'; contactId: string }
  | { kind: 'private_self' }
  | { kind: 'room'; channelId: string }
  | { kind: 'publication_state'; mode: ProjectPublicationMode };

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
  schemaVersion: typeof CURRENT_PROJECT_SCHEMA_VERSION;
  kind: 'personal_project';
  id: string;
  ref: string;
  title: string;
  status: PersonalProjectStatus;
  visibility: CompanionOwnedVisibility;
  /** Durable, companion-owned work context (bible §10.3/§10.5). */
  workContext: PersonalProjectWorkContext;
  /**
   * Stable, lane-independent continuity session id (bible §10.4/§10.5). Runtime-
   * derived from the project id + work context; recomputed on every read.
   */
  continuitySessionRef: string;
  /** Default return policy (bible §10.8), runtime-derived from the work context. */
  returnPolicy: PersonalProjectReturnPolicy;
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

/**
 * Continuity-session partition prefix. MUST stay byte-identical to
 * `FREE_TIME_CHANNEL_PREFIX` in `src/core/session/session-id.ts` — the resolver
 * (`src/core/scheduler/free-time-workspace-resolver.ts`) derives the same session
 * ids at resolve time, and the two derivations must agree. Duplicated (not
 * imported) to keep this contracts module free of a scheduler/session
 * dependency; `deriveContinuitySessionRef.test` pins the format.
 */
const FREE_TIME_SESSION_PREFIX = 'internal:free-time:';

function isPublicationMode(value: unknown): value is ProjectPublicationMode {
  return value === 'public_clean' || value === 'expressive_review';
}

/**
 * Runtime-authoritative continuity session id for a project (bible §10.4). Keyed
 * by the project id + work-context kind so the trigger lane and room roster never
 * fork it. Matches the resolver's `privateProjectSessionId` /
 * `roomProjectSessionId` / `publicationProjectSessionId` derivations exactly.
 */
export function deriveContinuitySessionRef(
  projectId: string,
  workContext: PersonalProjectWorkContext,
): string {
  switch (workContext.kind) {
    case 'private':
      return `${FREE_TIME_SESSION_PREFIX}project:${projectId}`;
    case 'room':
      return `${FREE_TIME_SESSION_PREFIX}room:${projectId}`;
    case 'publication':
      return `${FREE_TIME_SESSION_PREFIX}publication:${workContext.mode}:${projectId}`;
    default: {
      const unknown = workContext as { kind?: unknown };
      throw new Error(`unknown project work-context kind: ${String(unknown.kind)}`);
    }
  }
}

/**
 * Runtime-authoritative default return policy for a project (bible §10.8),
 * derived purely from the work context. Mirrors the resolver's return-policy
 * assembly so the durable manifest and the resolved workspace agree.
 */
export function deriveProjectReturnPolicy(
  workContext: PersonalProjectWorkContext,
): PersonalProjectReturnPolicy {
  switch (workContext.kind) {
    case 'private':
      return workContext.returnTarget
        ? { kind: 'contact_dm', contactId: workContext.returnTarget.contactId }
        : { kind: 'private_self' };
    case 'room':
      return { kind: 'room', channelId: workContext.channelId };
    case 'publication':
      return { kind: 'publication_state', mode: workContext.mode };
    default: {
      const unknown = workContext as { kind?: unknown };
      throw new Error(`unknown project work-context kind: ${String(unknown.kind)}`);
    }
  }
}

function parseContactDmTarget(value: unknown, docId: string): ProjectContactDmTarget {
  if (!isRecord(value)) {
    throw new Error(`wiki document ${docId} has an invalid private returnTarget`);
  }
  const contactId = requiredProjectText(value.contactId, 'returnTarget contactId');
  if (value.channelId !== undefined) {
    return { contactId, channelId: requiredProjectText(value.channelId, 'returnTarget channelId') };
  }
  return { contactId };
}

/**
 * Fail-closed parse of a stored v2 work context. Any unknown kind, a missing
 * room channel id, or an invalid publication mode THROWS — nothing is coerced.
 */
function parseWorkContext(value: unknown, docId: string): PersonalProjectWorkContext {
  if (!isRecord(value)) {
    throw new Error(`wiki document ${docId} is missing its work context (bible §10.3)`);
  }
  switch (value.kind) {
    case 'private': {
      if (value.returnTarget === undefined) return { kind: 'private' };
      return { kind: 'private', returnTarget: parseContactDmTarget(value.returnTarget, docId) };
    }
    case 'room':
      return { kind: 'room', channelId: requiredProjectText(value.channelId, 'work-context channelId') };
    case 'publication': {
      if (!isPublicationMode(value.mode)) {
        throw new Error(`wiki document ${docId} has an invalid publication mode`);
      }
      if (value.surfaceRef === undefined) return { kind: 'publication', mode: value.mode };
      return {
        kind: 'publication',
        mode: value.mode,
        surfaceRef: requiredProjectText(value.surfaceRef, 'work-context surfaceRef'),
      };
    }
    default:
      throw new Error(`wiki document ${docId} has an unknown work-context kind: ${String(value.kind)}`);
  }
}

export function parsePersonalProjectDocument(document: WikiDocument): PersonalProjectManifest {
  if (document.sourceClass !== 'companion_authored_note' || (document.scope && document.scope !== 'personal')) {
    throw new Error(`wiki document ${document.id} is not companion-owned personal project data`);
  }
  const value = parseJsonBody(document);
  if (!isRecord(value) || value.kind !== 'personal_project') {
    throw new Error(`wiki document ${document.id} is not a personal project manifest`);
  }
  // Explicit, versioned handling — no silent fallback (AGENTS.md fail-closed).
  // v1 (no durable work context) and v2 are the only supported shapes; anything
  // else throws.
  if (value.schemaVersion !== 1 && value.schemaVersion !== CURRENT_PROJECT_SCHEMA_VERSION) {
    throw new Error(`wiki document ${document.id} has unsupported project schemaVersion: ${String(value.schemaVersion)}`);
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
  // Work context: v2 carries a stored, fail-closed work context; v1 predates the
  // field and is private-only, so it upgrades explicitly to a private context
  // (settled decision 16, §5.5). The disclosure-relevant continuity session id
  // and return policy are ALWAYS runtime-derived here and never read from the
  // persisted document — the runtime is authoritative for them (bible §6.2), so
  // a forged/drifted stored value cannot redirect a return note.
  const workContext: PersonalProjectWorkContext = value.schemaVersion === CURRENT_PROJECT_SCHEMA_VERSION
    ? parseWorkContext(value.workContext, document.id)
    : { kind: 'private' };
  return {
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    kind: 'personal_project',
    id,
    ref,
    title: requiredProjectText(value.title, 'project title'),
    status: value.status,
    visibility: value.visibility,
    workContext,
    continuitySessionRef: deriveContinuitySessionRef(id, workContext),
    returnPolicy: deriveProjectReturnPolicy(workContext),
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
