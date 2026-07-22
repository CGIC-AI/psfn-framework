import { createHash, randomBytes } from 'node:crypto';
import type {
  ContactProfileArtifact,
  MemoryStorePort,
} from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import type { ValuesJournalEntry } from '../../../faculties/values/store.js';
import type { ReflectionJournalEntry } from '../../../persistence/journals/reflection-journal.js';
import type { ReflectionMetacognitionJournalEntry } from '../../../persistence/journals/reflection-metacognition-journal.js';
import type { ReflectionDailyJournalEntry } from '../../../persistence/journals/reflection-substrate.js';
import {
  isPrivacyBreakGlassConfirmRoute,
  privacyBreakGlassReasonDigest,
  privacyBreakGlassResourceKindForRoute,
  privacyBreakGlassResourceSelectorDigest,
  privacyBreakGlassSubjectScopeDigest,
  type PrivacyBreakGlassConfirmRequest,
  type PrivacyBreakGlassDecideRequest,
  type PrivacyBreakGlassResourceKind,
} from '../../../shared/contracts/privacy-break-glass.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import type { FleetGardenRequestContext } from '../garden-request-context.js';

/**
 * The four companion-private journal streams gated by the values/reflection
 * read routes. The break-glass `:id` selector names exactly one stream; every
 * other selector is treated as unavailable so a disclosure only ever exposes a
 * known welfare substrate.
 */
export type PrivacyBreakGlassJournalStream =
  | 'values-journal'
  | 'reflection-metacognition'
  | 'reflection-daily'
  | 'reflection-journal';

export type PrivacyBreakGlassJournalEntry =
  | ValuesJournalEntry
  | ReflectionMetacognitionJournalEntry
  | ReflectionDailyJournalEntry
  | ReflectionJournalEntry;

export interface PrivacyBreakGlassJournalDisclosure {
  readonly stream: PrivacyBreakGlassJournalStream;
  readonly entries: readonly PrivacyBreakGlassJournalEntry[];
}

/**
 * Read side for journal break-glass disclosures. Mirrors the bounded-window
 * shape the gated GET routes serve: one exact stream, most-recent-first, capped
 * at `limit`. Kept separate from the memory store so the service never reaches
 * for a subject-scoped read path when disclosing companion-private journals.
 */
export interface PrivacyBreakGlassJournalReader {
  listStream(
    stream: PrivacyBreakGlassJournalStream,
    limit: number,
  ): readonly PrivacyBreakGlassJournalEntry[];
}

const JOURNAL_STREAMS: readonly PrivacyBreakGlassJournalStream[] = [
  'values-journal',
  'reflection-metacognition',
  'reflection-daily',
  'reflection-journal',
];

function journalStream(value: string): PrivacyBreakGlassJournalStream | null {
  return (JOURNAL_STREAMS as readonly string[]).includes(value)
    ? value as PrivacyBreakGlassJournalStream
    : null;
}

export type PrivacyBreakGlassDisclosure =
  | { kind: 'memory'; memory: PurrMemory }
  | { kind: 'profile'; profile: ContactProfileArtifact }
  | { kind: 'journal'; journal: PrivacyBreakGlassJournalDisclosure };

export interface PrivacyBreakGlassAuditEvidence {
  assurance: 'webauthn_uv';
  resourceKind: PrivacyBreakGlassResourceKind;
  resourceSelectorDigest: string;
  reasonCategory: PrivacyBreakGlassConfirmRequest['reasonCategory'];
  reasonDigest: string;
  subjectScopeDigest: string;
  confirmationDecisionId: string;
  expiresAt: string;
}

export type PrivacyBreakGlassBeginResult =
  | {
    ok: true;
    confirmToken: string;
    expiresAt: string;
    audit: PrivacyBreakGlassAuditEvidence;
  }
  | { ok: false; status: 403 | 404 | 409; code: string };

export type PrivacyBreakGlassDecideResult =
  | {
    ok: true;
    disclosure: PrivacyBreakGlassDisclosure;
    audit: PrivacyBreakGlassAuditEvidence;
  }
  | { ok: false; status: 403 | 404 | 409; code: string };

interface PendingPrivacyBreakGlassDecision {
  token: string;
  authorityBinding: string;
  resourceKind: PrivacyBreakGlassResourceKind;
  resourceId: string;
  resourceSnapshotDigest: string;
  subjectScopeDigest: string;
  reasonCategory: PrivacyBreakGlassConfirmRequest['reasonCategory'];
  reasonDigest: string;
  confirmationDecisionId: string;
  expiresAtMs: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactResourceId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('Privacy break-glass resource selector is invalid');
  }
  return normalized;
}

function authorityBinding(context: FleetGardenRequestContext): string {
  return digest(JSON.stringify({
    schemaVersion: 1,
    principalId: context.actor.principalId,
    provider: context.actor.provider,
    providerSubjectId: context.actor.providerSubjectId,
    contactId: context.actor.contactId,
    contactBindingId: context.actor.contactBindingId,
    companionId: context.resource.companionId,
    sessionRecordId: context.actor.sessionRecordId,
    operatorGrantId: context.actor.operatorGrantId,
    action: context.action,
    role: context.actor.role,
    versions: context.versions,
  }));
}

interface ExactNonSubjectResource {
  resource: PurrMemory | ContactProfileArtifact | PrivacyBreakGlassJournalDisclosure;
  subjectScopeDigest: string;
}

function snapshotDigest(value: ExactNonSubjectResource, kind: PrivacyBreakGlassResourceKind): string {
  return digest(JSON.stringify({ schemaVersion: 1, kind, value }));
}

function expectedRoute(kind: PrivacyBreakGlassResourceKind, phase: 'confirm' | 'decide'): string {
  return `POST /api/admin/privacy-break-glass/${kind}/:id/${phase}`;
}

export class AdminPrivacyBreakGlassService {
  private readonly pending = new Map<string, PendingPrivacyBreakGlassDecision>();

  constructor(private readonly options: {
    memoryStore: Pick<MemoryStorePort,
      'getById' | 'getContactProfile' | 'getMemorySubjectClassification'>;
    journalReader?: PrivacyBreakGlassJournalReader;
    confirmTtlMs: number;
    now?: () => number;
    randomBytes?: (length: number) => Buffer;
  }) {
    if (!Number.isSafeInteger(options.confirmTtlMs)
      || options.confirmTtlMs < 30_000
      || options.confirmTtlMs > 120_000) {
      throw new Error('Privacy break-glass confirmation TTL is invalid');
    }
  }

  async begin(input: {
    resourceKind: PrivacyBreakGlassResourceKind;
    resourceId: string;
    request: PrivacyBreakGlassConfirmRequest;
    context: FleetGardenRequestContext;
  }): Promise<PrivacyBreakGlassBeginResult> {
    const resourceId = exactResourceId(input.resourceId);
    if (input.context.action !== 'privacy.break_glass'
      || input.context.actor.sessionAssurance !== 'break_glass'
      || !isPrivacyBreakGlassConfirmRoute(input.context.resource.routeId)
      || privacyBreakGlassResourceKindForRoute(input.context.resource.routeId) !== input.resourceKind
      || input.context.resource.routeId !== expectedRoute(input.resourceKind, 'confirm')
      || input.context.resource.pathParams.id !== resourceId
      || !input.context.resource.companionId
      || !input.context.actor.principalId
      || !input.context.actor.contactId
      || !input.context.actor.sessionRecordId) {
      return { ok: false, status: 403, code: 'trusted_uv_authority_required' };
    }
    const current = await this.readExactNonSubject(
      input.resourceKind,
      resourceId,
      input.context.actor.contactId,
    );
    if (!current) return { ok: false, status: 404, code: 'resource_unavailable' };
    const now = (this.options.now ?? Date.now)();
    const expiresAtMs = now + this.options.confirmTtlMs;
    const confirmToken = (this.options.randomBytes ?? randomBytes)(32).toString('hex');
    const reasonDigest = privacyBreakGlassReasonDigest(input.request);
    const routeSubjectScopeDigest = privacyBreakGlassSubjectScopeDigest({
      companionId: input.context.resource.companionId,
      action: input.context.action,
      routeId: input.context.resource.routeId,
      resourceKind: input.resourceKind,
      resourceId,
    });
    const pending: PendingPrivacyBreakGlassDecision = {
      token: confirmToken,
      authorityBinding: authorityBinding(input.context),
      resourceKind: input.resourceKind,
      resourceId,
      resourceSnapshotDigest: snapshotDigest(current, input.resourceKind),
      subjectScopeDigest: digest(JSON.stringify({
        schemaVersion: 1,
        routeSubjectScopeDigest,
        resourceSubjectScopeDigest: current.subjectScopeDigest,
      })),
      reasonCategory: input.request.reasonCategory,
      reasonDigest,
      confirmationDecisionId: input.context.decisionId,
      expiresAtMs,
    };
    this.sweepExpired(now);
    this.pending.set(digest(confirmToken), pending);
    return {
      ok: true,
      confirmToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
      audit: this.auditEvidence(pending),
    };
  }

  async decide(input: {
    resourceKind: PrivacyBreakGlassResourceKind;
    resourceId: string;
    request: PrivacyBreakGlassDecideRequest;
    context: FleetGardenRequestContext;
  }): Promise<PrivacyBreakGlassDecideResult> {
    const resourceId = exactResourceId(input.resourceId);
    const key = digest(input.request.confirmToken);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    if (input.context.action !== 'privacy.break_glass'
      || input.context.resource.routeId !== expectedRoute(input.resourceKind, 'decide')
      || input.context.resource.pathParams.id !== resourceId
      || !input.context.resource.companionId
      || !input.context.actor.principalId
      || !input.context.actor.contactId
      || !input.context.actor.sessionRecordId) {
      return { ok: false, status: 403, code: 'trusted_principal_required' };
    }
    if (!pending || !timingSafeStringEqual(pending.token, input.request.confirmToken)) {
      return { ok: false, status: 403, code: 'confirmation_unavailable' };
    }
    const now = (this.options.now ?? Date.now)();
    if (now >= pending.expiresAtMs) {
      return { ok: false, status: 403, code: 'confirmation_expired' };
    }
    if (pending.resourceKind !== input.resourceKind
      || pending.resourceId !== resourceId
      || !timingSafeStringEqual(pending.authorityBinding, authorityBinding(input.context))
      || pending.reasonCategory !== input.request.reasonCategory
      || !timingSafeStringEqual(
        pending.reasonDigest,
        privacyBreakGlassReasonDigest(input.request),
      )) {
      return { ok: false, status: 403, code: 'confirmation_binding_changed' };
    }
    const current = await this.readExactNonSubject(
      input.resourceKind,
      resourceId,
      input.context.actor.contactId,
    );
    if (!current
      || !timingSafeStringEqual(
        pending.resourceSnapshotDigest,
        snapshotDigest(current, input.resourceKind),
      )) {
      return { ok: false, status: 409, code: 'resource_changed' };
    }
    let disclosure: PrivacyBreakGlassDisclosure;
    if (input.resourceKind === 'memory') {
      disclosure = { kind: 'memory', memory: current.resource as PurrMemory };
    } else if (input.resourceKind === 'profile') {
      disclosure = { kind: 'profile', profile: current.resource as ContactProfileArtifact };
    } else {
      disclosure = {
        kind: 'journal',
        journal: current.resource as PrivacyBreakGlassJournalDisclosure,
      };
    }
    return {
      ok: true,
      disclosure,
      audit: this.auditEvidence(pending),
    };
  }

  private async readExactNonSubject(
    kind: PrivacyBreakGlassResourceKind,
    resourceId: string,
    actorContactId: string,
  ): Promise<ExactNonSubjectResource | null> {
    if (kind === 'journal') {
      const stream = journalStream(resourceId);
      if (!stream || !this.options.journalReader) return null;
      // Code-owned least-disclosure ceiling; matches the gated GET routes.
      const entries = this.options.journalReader.listStream(stream, 250);
      return {
        resource: { stream, entries },
        subjectScopeDigest: digest(JSON.stringify({
          schemaVersion: 1,
          resourceKind: 'journal',
          stream,
        })),
      };
    }
    if (kind === 'profile') {
      if (timingSafeStringEqual(resourceId, actorContactId)) return null;
      const profile = await this.options.memoryStore.getContactProfile(resourceId);
      if (!profile || profile.contactId !== resourceId) return null;
      return {
        resource: profile,
        subjectScopeDigest: digest(JSON.stringify({
          schemaVersion: 1,
          resourceKind: 'profile',
          subjectContactId: profile.contactId,
        })),
      };
    }
    const [memory, classification] = await Promise.all([
      this.options.memoryStore.getById(resourceId),
      this.options.memoryStore.getMemorySubjectClassification(resourceId),
    ]);
    if (!memory || !classification
      || memory.id !== resourceId
      || classification.memoryId !== resourceId
      || classification.status !== 'current'
      || classification.subjectContactIds.length === 0
      || classification.subjectContactIds.includes(actorContactId)) {
      return null;
    }
    return {
      resource: memory,
      subjectScopeDigest: digest(JSON.stringify({
        schemaVersion: 1,
        resourceKind: 'memory',
        classification,
      })),
    };
  }

  private auditEvidence(
    pending: PendingPrivacyBreakGlassDecision,
  ): PrivacyBreakGlassAuditEvidence {
    return {
      assurance: 'webauthn_uv',
      resourceKind: pending.resourceKind,
      resourceSelectorDigest: privacyBreakGlassResourceSelectorDigest(
        pending.resourceKind,
        pending.resourceId,
      ),
      reasonCategory: pending.reasonCategory,
      reasonDigest: pending.reasonDigest,
      subjectScopeDigest: pending.subjectScopeDigest,
      confirmationDecisionId: pending.confirmationDecisionId,
      expiresAt: new Date(pending.expiresAtMs).toISOString(),
    };
  }

  private sweepExpired(now: number): void {
    for (const [key, pending] of this.pending) {
      if (now >= pending.expiresAtMs) this.pending.delete(key);
    }
  }
}
