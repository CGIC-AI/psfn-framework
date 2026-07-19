// ── Free-Time Workspace Resolver (bible §10.3 / §13.2) ──
//
// A single deep module that resolves a companion's free-time activity choice
// into every runtime fact the scheduler needs for the block:
//
//   1. a stable, lane-independent CONTINUITY SESSION id (§10.4);
//   2. the WORK CONTEXT (private / room / publication) (§10.3);
//   3. the RETRIEVAL + DISCLOSURE CEILING (§10.6/§10.7/§10.9/§10.10); and
//   4. the RETURN POLICY (§10.8).
//
// The scheduler must NOT independently calculate session identity, retrieval
// scope, return target, or disclosure ceiling (§10.3). This module owns that
// mapping so quiet-hours and idle triggers entering the SAME chosen workspace
// resolve to the SAME facts — the trigger lane is a reason free time opened, not
// a separate life (§10.4).
//
// Scope of THIS module (bead jp36.2.1.1): the pure `resolve(choice)` half only.
// The lightweight chooser / `listChoices` (jp36.2.1.2), the fixed-lane → session
// merge + migration (jp36.2.2.x), and the workspace-resolved return-note routing
// (jp36.2.3.x) are siblings that CONSUME this resolver; they are out of scope
// here. This module is deliberately pure and port-injected so it is fully
// unit-testable and carries no dependency on runtime trust-policy globals or the
// (not-yet-landed) project manifest v2 (jp36.2.4).
//
// Fail-closed posture (charter / AGENTS.md): an unknown project, an unresolvable
// room channel, or a "room" workspace bound to a non-room channel all THROW.
// Nothing is silently coerced, and no destination is ever guessed. The execution
// audience of every free-time turn is the companion herself; the DISCLOSURE
// CEILING is a separate, explicit fact (§10.7) — using `audience: self` alone
// would admit material a later room could not receive.

import {
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../../system/trust/types.js';
import type { ContextEnvelope } from '../../system/trust/context-envelope.js';
import type { DisclosureDestination } from '../cogsec/disclosure/index.js';
import { normalizeProjectEntityId } from '../../faculties/wiki/personal-project-contracts.js';
import { FREE_TIME_CHANNEL_PREFIX } from './free-time.js';

// ── Shared vocabulary ──

export type PublicationMode = 'public_clean' | 'expressive_review';

/**
 * The DM return target for private, contact-anchored free-time work (§10.6,
 * §10.8). The runtime return-note routing (jp36.2.3) resolves the concrete DM
 * `channelId` from the `contactId` at projection time; the resolver only needs
 * the stable `contactId`, so `channelId` is optional here.
 */
export interface ContactDmTarget {
  readonly contactId: string;
  readonly channelId?: string;
}

/**
 * The work context of a free-time workspace — the exact `FreeTimeWorkContext`
 * shape of bible §10.3. Private work may carry an optional DM return target;
 * a room workspace binds a stable ordinary channel and inherits its Context
 * Envelope; a publication workspace carries its mode and optional surface ref.
 */
export type FreeTimeWorkContext =
  | { readonly kind: 'private'; readonly returnTarget?: ContactDmTarget }
  | { readonly kind: 'room'; readonly channelId: string; readonly envelope: ContextEnvelope }
  | { readonly kind: 'publication'; readonly mode: PublicationMode; readonly surfaceRef?: string };

/**
 * A project's durable work context, independent of the manifest storage version.
 * The project already OWNS its work context, so resuming it requires no repeated
 * privacy question (§10.1). Manifest v2 (jp36.2.4) will populate this from the
 * stored manifest; a freshly created workspace supplies it inline.
 */
export type FreeTimeWorkspaceContext =
  | { readonly kind: 'private'; readonly returnTarget?: ContactDmTarget }
  | { readonly kind: 'room'; readonly channelId: string }
  | { readonly kind: 'publication'; readonly mode: PublicationMode; readonly surfaceRef?: string };

/**
 * The retrieval + disclosure ceiling for a workspace (§10.6/§10.7/§10.9/§10.10).
 * `retrievalCeiling` bounds the max sensitivity admissible into context
 * assembly; `disclosureCeiling` is the SEPARATE, most-open destination the
 * work's output may EVER reach — the execution audience stays `self` regardless
 * (§10.7). `allowBroadSelfRetrieval` is true only for companion-self spaces
 * (private free time and expressive-review drafts), which may draw broad memory.
 */
export interface FreeTimeRetrievalPolicy {
  readonly retrievalCeiling: SensitivityLevel;
  readonly disclosureCeiling: DisclosureDestination;
  readonly allowBroadSelfRetrieval: boolean;
}

/**
 * Where a return note for this workspace may go (§10.8). The resolver declares
 * the INTENDED destination; the return-note routing + destination-eligible
 * summarizer (jp36.2.3) narrows or omits unsafe detail (mixed-lineage private
 * work) at projection time. `private_self` covers unanchored/mixed private work
 * that keeps to the companion's own space.
 */
export type FreeTimeReturnPolicy =
  | { readonly kind: 'contact_dm'; readonly contactId: string }
  | { readonly kind: 'private_self' }
  | { readonly kind: 'room'; readonly channelId: string }
  | { readonly kind: 'publication_state'; readonly projectRef: string; readonly mode: PublicationMode };

/**
 * The fully-resolved workspace facts the scheduler consumes (§10.3). Everything
 * needed to open the block deterministically: continuity session, optional
 * project ref, work context, ceilings, and return policy.
 */
export interface FreeTimeWorkspace {
  readonly sessionId: string;
  readonly projectRef?: string;
  readonly workContext: FreeTimeWorkContext;
  readonly retrievalPolicy: FreeTimeRetrievalPolicy;
  readonly returnPolicy: FreeTimeReturnPolicy;
}

// ── Choice input ──

/**
 * A resolved free-time choice the chooser (jp36.2.1.2) hands the resolver AFTER
 * the companion has picked. `rest` is handled entirely by the chooser (it ends
 * the block without a second model call, §10.2) and never reaches `resolve`.
 *
 * - `private_wander`   — one continuous private free-time session (§10.4), no
 *                        project; optionally contact-anchored for return.
 * - `resume_project`   — an existing project resolved via the injected directory.
 * - `create_workspace` — a newly created project whose work context is supplied
 *                        inline (persistence is jp36.2.4's job, not the
 *                        resolver's).
 */
export type FreeTimeChoice =
  | { readonly kind: 'private_wander'; readonly returnTarget?: ContactDmTarget }
  | { readonly kind: 'resume_project'; readonly projectRef: string }
  | { readonly kind: 'create_workspace'; readonly projectRef: string; readonly workspace: FreeTimeWorkspaceContext };

// ── Injected ports (keep the resolver pure) ──

/**
 * A room channel resolved to its Context Envelope AND its disclosure ceiling.
 * `disclosureCeiling` is pre-computed by the caller from runtime trust policy
 * (`getVisibilityDisclosureCeiling`) so this module stays pure and free of
 * trust-policy globals. `null` from the resolver means the channel could not be
 * resolved — the resolver fails closed on it (§20.4 missing lineage fails
 * closed).
 */
export interface ResolvedRoomChannel {
  readonly envelope: ContextEnvelope;
  readonly disclosureCeiling: SensitivityLevel;
}

export type FreeTimeRoomChannelResolver = (channelId: string) => ResolvedRoomChannel | null;

/** A stored project's durable record, or `null` when the ref is unknown. */
export interface FreeTimeProjectRecord {
  readonly projectRef: string;
  readonly workspace: FreeTimeWorkspaceContext;
}

export type FreeTimeProjectDirectory = (projectRef: string) => FreeTimeProjectRecord | null;

export interface FreeTimeWorkspaceResolverDeps {
  /** Looks up an existing project's durable work context (manifest v2 seam, jp36.2.4). */
  readonly projectDirectory: FreeTimeProjectDirectory;
  /** Resolves a room channel to its envelope + disclosure ceiling. */
  readonly roomChannelResolver: FreeTimeRoomChannelResolver;
}

// ── Continuity session identity (§10.4) ──
//
// Lane-independent, workspace-keyed internal session ids. They all live under
// the existing `internal:free-time:` partition (owned by free-time.ts) so
// `isInternalSessionId()` marks them internal (non-egressing) and
// `isExperientialSelfDirectedSessionId()` counts their assistant turns as lived
// activity. A project's session is keyed by the project id — NOT the trigger
// lane and NOT the room roster — so participant churn never forks it (§10.7).

const PRIVATE_WANDER_SESSION_ID = `${FREE_TIME_CHANNEL_PREFIX}private`;

/** The most permissive retrieval ceiling — companion-self space admits everything (§10.6). */
const BROAD_RETRIEVAL_CEILING: SensitivityLevel = SENSITIVITY_LEVELS[SENSITIVITY_LEVELS.length - 1];
/** The public/broadcast retrieval ceiling for public-clean publication (§10.9). */
const PUBLIC_RETRIEVAL_CEILING: SensitivityLevel = SENSITIVITY_LEVELS[0];

/** Normalize a `project:<id>` ref to its bare, validated id (fails closed on a bad ref). */
function projectIdFromRef(projectRef: string): string {
  return normalizeProjectEntityId(projectRef.replace(/^project:/, ''), 'project ref');
}

function privateProjectSessionId(projectId: string): string {
  return `${FREE_TIME_CHANNEL_PREFIX}project:${projectId}`;
}

function roomProjectSessionId(projectId: string): string {
  return `${FREE_TIME_CHANNEL_PREFIX}room:${projectId}`;
}

function publicationProjectSessionId(projectId: string, mode: PublicationMode): string {
  return `${FREE_TIME_CHANNEL_PREFIX}publication:${mode}:${projectId}`;
}

// ── Ceiling derivation ──

/**
 * The disclosure ROOM destination for a room workspace, derived purely from the
 * channel's envelope. An `invite_only` channel maps to `invite_only_room`; a
 * `public` (or broadcast) channel maps to `public_room`. A private (non-room)
 * channel is not a valid room workspace target and fails closed.
 */
function roomDisclosureDestination(channelId: string, envelope: ContextEnvelope): DisclosureDestination {
  if (envelope.channelPrivacy === 'invite_only') return { kind: 'invite_only_room', channelId };
  if (envelope.channelPrivacy === 'public' || envelope.broadcast) return { kind: 'public_room', channelId };
  throw new Error(
    `free-time room workspace bound to a non-room channel ${channelId} `
    + `(channelPrivacy=${envelope.channelPrivacy}, broadcast=${envelope.broadcast}); `
    + 'a room workspace requires an invite-only or public channel (bible §10.7)',
  );
}

function privateRetrievalPolicy(): FreeTimeRetrievalPolicy {
  // Private free time is companion-self space: broad retrieval is allowed, but
  // nothing escapes — the disclosure ceiling stays companion-self regardless of
  // any return target (§10.6).
  return {
    retrievalCeiling: BROAD_RETRIEVAL_CEILING,
    disclosureCeiling: { kind: 'companion_self' },
    allowBroadSelfRetrieval: true,
  };
}

function roomRetrievalPolicy(channel: ResolvedRoomChannel, channelId: string): FreeTimeRetrievalPolicy {
  // Room-compatible retrieval: admitted material is bounded by the room's own
  // disclosure ceiling so it can later reach the room; the disclosure ceiling IS
  // that room (§10.7).
  return {
    retrievalCeiling: channel.disclosureCeiling,
    disclosureCeiling: roomDisclosureDestination(channelId, channel.envelope),
    allowBroadSelfRetrieval: false,
  };
}

function publicationRetrievalPolicy(mode: PublicationMode): FreeTimeRetrievalPolicy {
  if (mode === 'public_clean') {
    // Public-clean projects begin with a public/broadcast ceiling and receive no
    // private DM or introspection context (§10.9).
    return {
      retrievalCeiling: PUBLIC_RETRIEVAL_CEILING,
      disclosureCeiling: { kind: 'publication' },
      allowBroadSelfRetrieval: false,
    };
  }
  // Expressive review may draw from deep private experience, but the draft stays
  // private and carries restricted lineage — no autonomous public egress. The
  // disclosure ceiling is companion-self until an exact release candidate is
  // human-approved (§10.10).
  return {
    retrievalCeiling: BROAD_RETRIEVAL_CEILING,
    disclosureCeiling: { kind: 'companion_self' },
    allowBroadSelfRetrieval: true,
  };
}

// ── Work-context / return-policy assembly per kind ──

function resolvePrivateWorkspace(
  sessionId: string,
  returnTarget: ContactDmTarget | undefined,
  projectRef: string | undefined,
): FreeTimeWorkspace {
  const workContext: FreeTimeWorkContext = returnTarget
    ? { kind: 'private', returnTarget }
    : { kind: 'private' };
  const returnPolicy: FreeTimeReturnPolicy = returnTarget
    ? { kind: 'contact_dm', contactId: returnTarget.contactId }
    : { kind: 'private_self' };
  return {
    sessionId,
    ...(projectRef ? { projectRef } : {}),
    workContext,
    retrievalPolicy: privateRetrievalPolicy(),
    returnPolicy,
  };
}

function resolveRoomWorkspace(
  projectRef: string,
  channelId: string,
  deps: FreeTimeWorkspaceResolverDeps,
): FreeTimeWorkspace {
  const trimmed = channelId.trim();
  if (!trimmed) throw new Error(`free-time room workspace ${projectRef} is missing a channel id (bible §10.7)`);
  const channel = deps.roomChannelResolver(trimmed);
  if (!channel) {
    throw new Error(
      `free-time room workspace ${projectRef} could not resolve channel ${trimmed}; `
      + 'unresolvable room fails closed (bible §20.4)',
    );
  }
  return {
    sessionId: roomProjectSessionId(projectIdFromRef(projectRef)),
    projectRef,
    workContext: { kind: 'room', channelId: trimmed, envelope: channel.envelope },
    retrievalPolicy: roomRetrievalPolicy(channel, trimmed),
    returnPolicy: { kind: 'room', channelId: trimmed },
  };
}

function resolvePublicationWorkspace(
  projectRef: string,
  mode: PublicationMode,
  surfaceRef: string | undefined,
): FreeTimeWorkspace {
  return {
    sessionId: publicationProjectSessionId(projectIdFromRef(projectRef), mode),
    projectRef,
    workContext: surfaceRef
      ? { kind: 'publication', mode, surfaceRef }
      : { kind: 'publication', mode },
    retrievalPolicy: publicationRetrievalPolicy(mode),
    returnPolicy: { kind: 'publication_state', projectRef, mode },
  };
}

/** Resolve a project workspace (resume or freshly created) from its work context. */
function resolveProjectWorkspace(
  projectRef: string,
  workspace: FreeTimeWorkspaceContext,
  deps: FreeTimeWorkspaceResolverDeps,
): FreeTimeWorkspace {
  switch (workspace.kind) {
    case 'private':
      return resolvePrivateWorkspace(
        privateProjectSessionId(projectIdFromRef(projectRef)),
        workspace.returnTarget,
        projectRef,
      );
    case 'room':
      return resolveRoomWorkspace(projectRef, workspace.channelId, deps);
    case 'publication':
      return resolvePublicationWorkspace(projectRef, workspace.mode, workspace.surfaceRef);
    default: {
      // Exhaustiveness guard: fail closed on an unknown workspace kind.
      const unknown = workspace as { kind?: unknown };
      throw new Error(`unknown free-time workspace kind: ${String(unknown.kind)}`);
    }
  }
}

// ── Public resolve seam ──

/**
 * Resolve a free-time choice into its complete workspace facts (§10.3). Pure and
 * deterministic given the injected ports; the same choice always resolves to the
 * same continuity session, ceilings, and return policy regardless of trigger
 * lane (§10.4). Fails closed on an unknown project, an unresolvable room, or a
 * room workspace bound to a non-room channel.
 */
export function resolveFreeTimeWorkspace(
  choice: FreeTimeChoice,
  deps: FreeTimeWorkspaceResolverDeps,
): FreeTimeWorkspace {
  switch (choice.kind) {
    case 'private_wander':
      return resolvePrivateWorkspace(PRIVATE_WANDER_SESSION_ID, choice.returnTarget, undefined);
    case 'resume_project': {
      const record = deps.projectDirectory(choice.projectRef);
      if (!record) {
        throw new Error(
          `free-time resume target ${choice.projectRef} is not a known project; `
          + 'unknown project fails closed (bible §10.3)',
        );
      }
      return resolveProjectWorkspace(record.projectRef, record.workspace, deps);
    }
    case 'create_workspace':
      return resolveProjectWorkspace(choice.projectRef, choice.workspace, deps);
    default: {
      const unknown = choice as { kind?: unknown };
      throw new Error(`unknown free-time choice kind: ${String(unknown.kind)}`);
    }
  }
}

/**
 * The `resolve` half of the bible §13.2 `FreeTimeWorkspaceResolver` interface.
 * `listChoices` is added by the chooser bead (jp36.2.1.2), which composes this
 * resolver. Async to match the §13.2 signature; the deep logic itself is pure.
 */
export class FreeTimeWorkspaceResolver {
  constructor(private readonly deps: FreeTimeWorkspaceResolverDeps) {}

  async resolve(choice: FreeTimeChoice): Promise<FreeTimeWorkspace> {
    return resolveFreeTimeWorkspace(choice, this.deps);
  }
}
