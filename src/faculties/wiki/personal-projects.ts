import { createHash } from 'node:crypto';
import {
  sensitivityOrd,
  type SensitivityLevel,
} from '../../system/trust/types.js';
import { isRecord } from '../../shared/utils/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { WikiDocumentListEntry, WikiStorePort } from './types.js';
import {
  normalizeProjectEntityId,
  parseNamedWardrobeLookDocument,
  parsePersonalProjectDocument,
  requiredProjectText,
  type CompanionOwnedVisibility,
  type NamedWardrobeLook,
  type PersonalProjectArtifact,
  type PersonalProjectManifest,
  type PersonalProjectStatus,
  type ResolvedWardrobeLook,
} from './personal-project-contracts.js';
export {
  parseNamedWardrobeLookDocument,
  parsePersonalProjectDocument,
} from './personal-project-contracts.js';
export type {
  CompanionOwnedVisibility,
  NamedWardrobeLook,
  PersonalProjectArtifact,
  PersonalProjectManifest,
  PersonalProjectStatus,
  ProjectArtifactShareState,
  ResolvedWardrobeLook,
} from './personal-project-contracts.js';

export interface PersonalProjectActivitySink {
  recordProjectActivity(project: PersonalProjectManifest): Promise<void>;
}

export interface LegacyArtifactQuarantineEntry {
  projectRef: string;
  artifactRef: string;
}

/**
 * Result of the one-time legacy-artifact quarantine migration
 * (psfn-framework-jp36.1.2.2). Counts are stable across re-runs — once every
 * artifact carries a `metadataLineage`, a subsequent run quarantines nothing.
 */
export interface LegacyArtifactQuarantineReport {
  dryRun: boolean;
  scannedProjects: number;
  scannedArtifacts: number;
  /** Artifacts already carrying a lineage marker (runtime_derived or legacy_unverified). */
  alreadyClassifiedArtifacts: number;
  /** Artifacts newly marked legacy_unverified and contained to private/self. */
  quarantinedArtifacts: number;
  /** Projects that had at least one artifact quarantined. */
  quarantinedProjects: number;
  malformedProjects: Array<{ id: string; error: string }>;
  /** Bounded sample of the quarantined artifacts (first N). */
  entries: LegacyArtifactQuarantineEntry[];
}

const QUARANTINE_REPORT_SAMPLE_LIMIT = 50;

const PROJECT_TAGS = ['psfn:personal-project'] satisfies readonly string[];
const WARDROBE_TAGS = ['psfn:named-look'] satisfies readonly string[];

function slugFromName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .replace(/-{2,}/g, '')
    .slice(0, 64)
    .replace(/[-_]+$/g, '');
  if (!slug) throw new Error('name cannot produce a stable id');
  return slug;
}

function projectDocId(id: string): string {
  return `project.${id}`;
}

function wardrobeDocId(id: string): string {
  return `wardrobe.look.${id}`;
}

/**
 * Wiki document id namespaces owned exclusively by the runtime-authoritative
 * personal-project / named-look paths. Derived from {@link projectDocId} /
 * {@link wardrobeDocId} so they never drift.
 */
export const RESERVED_MANAGED_WIKI_DOC_ID_PREFIXES = [
  projectDocId(''),
  wardrobeDocId(''),
] as const;

/** Tags reserved for runtime-managed companion-owned manifests. */
export const RESERVED_MANAGED_WIKI_TAGS = [PROJECT_TAGS[0], WARDROBE_TAGS[0]] as const;

/**
 * True when a generic `wiki` write/import would land in the reserved
 * personal-project / named-look namespace (by resolved document id prefix OR by
 * a reserved tag). The generic write action is model-controlled — body, id, and
 * tags all originate from the model — so a write into this namespace could forge
 * a project manifest whose artifacts assert `metadataLineage: runtime_derived`
 * (and model-chosen sensitivity/intendedAudience/shareState), which
 * `parsePersonalProjectDocument` would then read back verbatim and treat as
 * egress-eligible. That defeats the runtime-metadata-authority derivation
 * (bible §6.2) and the legacy egress quarantine (§9.5;
 * psfn-framework-jp36.1.2.3). These manifests are only ever written through the
 * dedicated project_* / wardrobe_* actions, which derive disclosure metadata
 * from runtime state and fail closed. Comparison is done on trimmed/lowercased
 * values to match the store's id/tag normalization.
 */
export function isReservedManagedWikiWrite(input: {
  documentId: string;
  tags?: readonly string[] | string | undefined;
}): boolean {
  const documentId = input.documentId.trim().toLowerCase();
  if (documentId && RESERVED_MANAGED_WIKI_DOC_ID_PREFIXES.some(prefix => documentId.startsWith(prefix))) {
    return true;
  }
  const rawTags = input.tags === undefined
    ? []
    : typeof input.tags === 'string'
      ? input.tags.split(',')
      : input.tags;
  return rawTags
    .map(tag => tag.trim().toLowerCase())
    .some(tag => (RESERVED_MANAGED_WIKI_TAGS as readonly string[]).some(reserved => reserved === tag));
}

function visibilitySensitivity(visibility: CompanionOwnedVisibility): SensitivityLevel {
  if (visibility === 'public') return 'public';
  if (visibility === 'primary_contact') return 'personal';
  return 'intimate';
}

function highestProjectSensitivity(project: PersonalProjectManifest): SensitivityLevel {
  return project.artifacts.reduce<SensitivityLevel>((highest, artifact) => (
    sensitivityOrd(artifact.sensitivity) > sensitivityOrd(highest) ? artifact.sensitivity : highest
  ), visibilitySensitivity(project.visibility));
}

function hasTag(entry: WikiDocumentListEntry, tag: string): boolean {
  return entry.tags.some(candidate => candidate === tag);
}

function stableArtifactId(ref: string): string {
  return createHash('sha256').update(ref, 'utf8').digest('hex').slice(0, 16);
}

function assertVisibleTo(
  visibility: CompanionOwnedVisibility,
  audience: CompanionOwnedVisibility,
  ref: string,
): void {
  if (audience === 'self') return;
  if (audience === 'primary_contact' && visibility !== 'self') return;
  if (audience === 'public' && visibility === 'public') return;
  throw new Error(`${ref} is not visible to audience=${audience}`);
}

export class PersonalProjectLibrary {
  private activitySink: PersonalProjectActivitySink | null = null;

  constructor(
    private readonly store: WikiStorePort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  setActivitySink(sink: PersonalProjectActivitySink): void {
    this.activitySink = sink;
  }

  listProjects(): PersonalProjectManifest[] {
    return this.store.list()
      .filter(entry => hasTag(entry, PROJECT_TAGS[0]))
      .map((entry) => {
        const document = this.store.get(entry.id);
        if (!document) throw new Error(`project manifest disappeared during listing: ${entry.id}`);
        return parsePersonalProjectDocument(document);
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getProject(refOrId: string): PersonalProjectManifest {
    const id = normalizeProjectEntityId(refOrId.replace(/^project:/, ''), 'project id');
    const document = this.store.get(projectDocId(id));
    if (!document) throw new Error(`personal project not found: project:${id}`);
    return parsePersonalProjectDocument(document);
  }

  async createProject(input: {
    id?: string;
    title: string;
    nextStep: string;
    visibility?: CompanionOwnedVisibility;
  }): Promise<PersonalProjectManifest> {
    const title = requiredProjectText(input.title, 'project title');
    const id = normalizeProjectEntityId(input.id ?? slugFromName(title), 'project id');
    if (this.store.get(projectDocId(id))) throw new Error(`personal project already exists: project:${id}`);
    const timestamp = this.now().toISOString();
    const project: PersonalProjectManifest = {
      schemaVersion: 1,
      kind: 'personal_project',
      id,
      ref: `project:${id}`,
      title,
      status: 'active',
      visibility: input.visibility ?? 'self',
      nextStep: requiredProjectText(input.nextStep, 'project nextStep'),
      artifacts: [],
      resumeCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.persistProject(project);
    await this.recordActivity(project);
    return project;
  }

  async updateProject(input: {
    ref: string;
    nextStep?: string;
    status?: PersonalProjectStatus;
    visibility?: CompanionOwnedVisibility;
  }): Promise<PersonalProjectManifest> {
    const current = this.getProject(input.ref);
    const updated: PersonalProjectManifest = {
      ...current,
      ...(input.nextStep !== undefined ? { nextStep: requiredProjectText(input.nextStep, 'project nextStep') } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      updatedAt: this.now().toISOString(),
    };
    this.persistProject(updated);
    await this.recordActivity(updated);
    return updated;
  }

  async addArtifact(input: {
    projectRef: string;
    artifactRef: string;
    label: string;
  }): Promise<PersonalProjectManifest> {
    const current = this.getProject(input.projectRef);
    const ref = requiredProjectText(input.artifactRef, 'artifact ref');
    if (current.artifacts.some(artifact => artifact.ref === ref)) {
      throw new Error(`artifact is already linked to ${current.ref}: ${ref}`);
    }
    // Bible §6.2: the runtime, not the model, is authoritative for artifact
    // sensitivity and permitted audience. Derive both from the project's
    // runtime-stored visibility (the workspace disclosure floor) rather than
    // from model-supplied tool arguments (§9.2 item 6). Intended audience fails
    // closed to `self`; broadening happens only through an explicit
    // project_share request that still passes the artifact egress gate.
    const sensitivity = visibilitySensitivity(current.visibility);
    const intendedAudience: CompanionOwnedVisibility = 'self';
    const updated: PersonalProjectManifest = {
      ...current,
      artifacts: [
        ...current.artifacts,
        {
          ref,
          label: requiredProjectText(input.label, 'artifact label'),
          sensitivity,
          intendedAudience,
          shareState: 'private',
          // Runtime-derived lineage: sensitivity/audience above came from
          // runtime state, not model assertion, so this artifact is eligible
          // for the egress gate (bible §6.2, §9.5).
          metadataLineage: 'runtime_derived',
          addedAt: this.now().toISOString(),
        },
      ],
      updatedAt: this.now().toISOString(),
    };
    this.persistProject(updated);
    await this.recordActivity(updated);
    return updated;
  }

  async requestArtifactShare(input: {
    projectRef: string;
    artifactRef: string;
    audience: CompanionOwnedVisibility;
  }): Promise<PersonalProjectManifest> {
    const current = this.getProject(input.projectRef);
    const artifactRef = requiredProjectText(input.artifactRef, 'artifact ref');
    const artifactIndex = current.artifacts.findIndex(artifact => artifact.ref === artifactRef);
    if (artifactIndex < 0) throw new Error(`artifact is not linked to ${current.ref}: ${artifactRef}`);
    // Bible §9.5: an artifact with unverified legacy disclosure metadata is not
    // automatically shareable. Fail closed at this egress point — a request to
    // broaden its audience beyond `self` is rejected until the artifact is
    // re-grounded (its metadata re-derived by the runtime).
    const target = current.artifacts[artifactIndex];
    if (target.metadataLineage === 'legacy_unverified' && input.audience !== 'self') {
      throw new Error(
        `${artifactRef} has unverified legacy disclosure metadata (bible §9.5) and must be `
        + 're-grounded before it can be shared beyond self',
      );
    }
    const artifacts = current.artifacts.map((artifact) => {
      if (artifact.ref !== artifactRef) return artifact;
      return {
        ...artifact,
        intendedAudience: input.audience,
        shareState: input.audience === 'self' ? 'private' : 'requested',
      } satisfies PersonalProjectArtifact;
    });
    const updated: PersonalProjectManifest = {
      ...current,
      artifacts,
      updatedAt: this.now().toISOString(),
    };
    this.persistProject(updated);
    return updated;
  }

  /**
   * One-time, idempotent quarantine of pre-existing model-asserted artifact
   * metadata (psfn-framework-jp36.1.2.2, bible §9.5). Before runtime metadata
   * authority (§6.2) landed, `project_add_artifact` accepted model-supplied
   * sensitivity/audience; those persisted values carry no `metadataLineage`
   * marker. This scan marks every such artifact `legacy_unverified` and
   * contains it to `private`/`self` so it fails closed at the egress gate until
   * re-grounded. Artifacts that already carry a lineage marker (runtime-derived
   * writes, or a prior quarantine run) are left untouched, so re-running is a
   * no-op with stable counts. Malformed project documents are reported, never
   * silently skipped, and never rewritten.
   */
  quarantineLegacyArtifacts(options: { dryRun: boolean }): LegacyArtifactQuarantineReport {
    const entries: LegacyArtifactQuarantineEntry[] = [];
    const malformedProjects: Array<{ id: string; error: string }> = [];
    let scannedProjects = 0;
    let scannedArtifacts = 0;
    let alreadyClassifiedArtifacts = 0;
    let quarantinedArtifacts = 0;
    let quarantinedProjects = 0;

    for (const entry of this.store.list().filter(candidate => hasTag(candidate, PROJECT_TAGS[0]))) {
      const document = this.store.get(entry.id);
      if (!document) throw new Error(`project manifest disappeared during quarantine scan: ${entry.id}`);

      // Validate the document up front; a genuinely malformed manifest is
      // reported and skipped rather than rewritten or silently dropped.
      let manifest: PersonalProjectManifest;
      let rawArtifacts: unknown[];
      try {
        manifest = parsePersonalProjectDocument(document);
        const rawBody: unknown = JSON.parse(document.body);
        if (!isRecord(rawBody) || !Array.isArray(rawBody.artifacts)) {
          throw new Error('project body is not a manifest with an artifacts array');
        }
        rawArtifacts = rawBody.artifacts;
      } catch (error) {
        malformedProjects.push({ id: document.id, error: toErrorMessage(error) });
        continue;
      }

      scannedProjects += 1;
      // parsePersonalProjectDocument preserves artifact order and never drops
      // entries on success, so the validated manifest and the raw array align
      // by index; the raw entry is the source of truth for whether the stored
      // document carried a lineage marker before this run.
      const quarantinedIndexes = new Set<number>();
      manifest.artifacts.forEach((_artifact, index) => {
        scannedArtifacts += 1;
        const rawEntry = rawArtifacts[index];
        const rawLineage = isRecord(rawEntry) ? rawEntry.metadataLineage : undefined;
        if (rawLineage === 'runtime_derived' || rawLineage === 'legacy_unverified') {
          alreadyClassifiedArtifacts += 1;
          return;
        }
        quarantinedArtifacts += 1;
        quarantinedIndexes.add(index);
        if (entries.length < QUARANTINE_REPORT_SAMPLE_LIMIT) {
          entries.push({ projectRef: manifest.ref, artifactRef: manifest.artifacts[index].ref });
        }
      });

      if (quarantinedIndexes.size === 0) continue;
      quarantinedProjects += 1;
      if (options.dryRun) continue;

      const quarantined: PersonalProjectManifest = {
        ...manifest,
        artifacts: manifest.artifacts.map((artifact, index) => (
          quarantinedIndexes.has(index)
            ? {
              ...artifact,
              // Contain to the most private posture and mark the metadata
              // unverified (§9.5). The asserted sensitivity field is retained
              // per the parent bug's non-goal (do not remove metadata fields).
              metadataLineage: 'legacy_unverified',
              intendedAudience: 'self',
              shareState: 'private',
            } satisfies PersonalProjectArtifact
            : artifact
        )),
      };
      this.persistProject(quarantined);
    }

    return {
      dryRun: options.dryRun,
      scannedProjects,
      scannedArtifacts,
      alreadyClassifiedArtifacts,
      quarantinedArtifacts,
      quarantinedProjects,
      malformedProjects,
      entries,
    };
  }

  async resumeNextActiveProject(): Promise<{ project: PersonalProjectManifest; context: string } | null> {
    const project = this.listProjects()
      .filter(candidate => candidate.status === 'active')
      .sort((left, right) => {
        const leftResumed = left.lastResumedAt ?? left.createdAt;
        const rightResumed = right.lastResumedAt ?? right.createdAt;
        return leftResumed.localeCompare(rightResumed);
      }).at(0);
    if (!project) return null;
    const resumedAt = this.now().toISOString();
    const resumed: PersonalProjectManifest = {
      ...project,
      resumeCount: project.resumeCount + 1,
      lastResumedAt: resumedAt,
      updatedAt: resumedAt,
    };
    this.persistProject(resumed);
    await this.recordActivity(resumed);
    return {
      project: resumed,
      context: [
        '[Returning to one of your projects]',
        `Project: ${resumed.title} (${resumed.ref})`,
        `Your last intention: ${resumed.nextStep}`,
        resumed.artifacts.length > 0
          ? `Recent artifacts:\n${resumed.artifacts.slice(-5).map(artifact => `- ${artifact.label}: ${artifact.ref}`).join('\n')}`
          : 'Recent artifacts: none yet.',
        'This is your own continuing work. You may resume it, change direction, choose another project, or rest.',
      ].join('\n'),
    };
  }

  listWardrobeLooks(): NamedWardrobeLook[] {
    return this.store.list()
      .filter(entry => hasTag(entry, WARDROBE_TAGS[0]))
      .map((entry) => {
        const document = this.store.get(entry.id);
        if (!document) throw new Error(`named look disappeared during listing: ${entry.id}`);
        return parseNamedWardrobeLookDocument(document);
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  saveNamedLook(input: {
    id?: string;
    name: string;
    promptFragment: string;
    visibility?: CompanionOwnedVisibility;
    supersedesRef?: string;
  }): NamedWardrobeLook {
    const name = requiredProjectText(input.name, 'look name');
    const id = normalizeProjectEntityId(input.id ?? slugFromName(name), 'look id');
    if (this.store.get(wardrobeDocId(id))) throw new Error(`named look already exists: wardrobe:${id}`);
    const timestamp = this.now().toISOString();
    const look: NamedWardrobeLook = {
      schemaVersion: 1,
      kind: 'named_wardrobe_look',
      id,
      ref: `wardrobe:${id}`,
      name,
      promptFragment: requiredProjectText(input.promptFragment, 'look promptFragment'),
      visibility: input.visibility ?? 'self',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.supersedesRef ? { supersedesRef: requiredProjectText(input.supersedesRef, 'look supersedesRef') } : {}),
    };
    if (look.supersedesRef) {
      const previous = this.getWardrobeLook(look.supersedesRef);
      if (previous.supersededByRef) {
        throw new Error(`${previous.ref} was already superseded by ${previous.supersededByRef}`);
      }
      this.persistLook({ ...previous, supersededByRef: look.ref, updatedAt: timestamp });
    }
    this.persistLook(look);
    return look;
  }

  reviseNamedLook(input: {
    ref: string;
    promptFragment: string;
    visibility?: CompanionOwnedVisibility;
  }): NamedWardrobeLook {
    const current = this.getWardrobeLook(input.ref);
    if (current.supersededByRef) throw new Error(`${current.ref} was superseded by ${current.supersededByRef}`);
    const revised: NamedWardrobeLook = {
      ...current,
      promptFragment: requiredProjectText(input.promptFragment, 'look promptFragment'),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      updatedAt: this.now().toISOString(),
    };
    this.persistLook(revised);
    return revised;
  }

  getWardrobeLook(refOrId: string): NamedWardrobeLook {
    const id = normalizeProjectEntityId(refOrId.replace(/^wardrobe:/, ''), 'look id');
    const document = this.store.get(wardrobeDocId(id));
    if (!document) throw new Error(`named look not found: wardrobe:${id}`);
    return parseNamedWardrobeLookDocument(document);
  }

  resolveWardrobeLook(ref: string, audience: CompanionOwnedVisibility = 'self'): ResolvedWardrobeLook {
    const look = this.getWardrobeLook(ref);
    if (look.supersededByRef) {
      throw new Error(`${look.ref} was superseded by ${look.supersededByRef}; use the current stable reference`);
    }
    assertVisibleTo(look.visibility, audience, look.ref);
    return { ref: look.ref, name: look.name, promptFragment: look.promptFragment };
  }

  private persistProject(project: PersonalProjectManifest): void {
    this.store.upsert({
      id: projectDocId(project.id),
      title: `Project: ${project.title}`,
      body: JSON.stringify(project, null, 2),
      tags: [...PROJECT_TAGS, `project:${project.id}`, `project-status:${project.status}`],
      sourceClass: 'companion_authored_note',
      sensitivity: highestProjectSensitivity(project),
      summary: `${project.status}: ${project.nextStep}`,
      updatedBy: 'agent:personal-projects',
    });
  }

  private persistLook(look: NamedWardrobeLook): void {
    this.store.upsert({
      id: wardrobeDocId(look.id),
      title: `Named look: ${look.name}`,
      body: JSON.stringify(look, null, 2),
      tags: [...WARDROBE_TAGS, `wardrobe:${look.id}`],
      sourceClass: 'companion_authored_note',
      sensitivity: visibilitySensitivity(look.visibility),
      summary: look.promptFragment,
      updatedBy: 'agent:personal-projects',
    });
  }

  private async recordActivity(project: PersonalProjectManifest): Promise<void> {
    if (!this.activitySink) return;
    await this.activitySink.recordProjectActivity(project);
  }
}

export function projectArtifactReference(projectRef: string, artifactRef: string): string {
  return `${projectRef}#artifact:${stableArtifactId(artifactRef)}`;
}
