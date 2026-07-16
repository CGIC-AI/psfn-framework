import type { PurrMemory } from '../../../faculties/memory/types.js';
import {
  MEMORY_SUBJECT_CLASSIFIER_VERSION,
  type MemorySubjectClassification,
} from '../../../shared/contracts/memory-subject.js';
import {
  memorySubjectClassifierEvidenceDigest,
  memorySubjectScopeDigest,
  type MemorySubjectJitRequest,
} from '../../../shared/contracts/memory-subject-jit.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { isHighIntimacySensitivityLevel } from '../../../system/trust/types.js';
import type {
  AdminMemoryBodyRedaction,
  AdminMemoryElevationStatus,
  AdminMemorySessionKey,
  AdminMemoryView,
} from './types.js';

/**
 * TTL for Garden memory body access grants (session elevation and per-item
 * reveals). This is a documented constant rather than a settings.json owner
 * entry: the operator-facing settings contract has no existing admin-surface
 * privacy domain, and inventing one for a single knob would cut across the
 * owner-file schema work other epics own. 15 minutes bounds shoulder-surfing
 * exposure while staying workable for a curation session.
 */
export const ADMIN_MEMORY_BODY_ACCESS_TTL_MS = 15 * 60 * 1_000;

export const ADMIN_MEMORY_BODY_REDACTION_REASON = 'high_intimacy_sensitivity' as const;

const REVEAL_HINT = 'Reveal this memory or elevate Garden memory body access to view (both are audit-logged).';

function isHighIntimacyMemory(memory: Pick<PurrMemory, 'sensitivity'>): boolean {
  return isHighIntimacySensitivityLevel(memory.sensitivity);
}

/**
 * Builds the explicit, honest redaction marker for a hidden memory body.
 * Charter 3.2: a MARKED redaction is honest; silent omission is not. The
 * marker names what is hidden (sensitivity level, original character count)
 * and how to reveal it.
 */
export function buildMemoryBodyRedactionMarker(memory: Pick<PurrMemory, 'sensitivity' | 'text'>): string {
  return `[REDACTED ${memory.sensitivity} memory body — ${memory.text.length} chars hidden. ${REVEAL_HINT}]`;
}

function buildBodyRedaction(memory: Pick<PurrMemory, 'sensitivity' | 'text'>): AdminMemoryBodyRedaction {
  return {
    sensitivity: memory.sensitivity,
    originalLength: memory.text.length,
    reason: ADMIN_MEMORY_BODY_REDACTION_REASON,
    revealHint: REVEAL_HINT,
  };
}

interface AdminMemorySessionGrants {
  elevationExpiresAt: number | null;
  revealExpiryById: Map<string, number>;
}

export interface FleetMemoryBodyAuthorizationContext {
  principalId: string;
  browserSessionId: string;
  companionId: string;
  viewerContactId: string;
  viewerRelation: 'self' | 'co_subject';
  action: 'memory.jit.self';
  resourceMemoryId: string;
  assurance: 'webauthn_uv';
  authorityGeneration: number;
  globalAuthEpoch: number;
  sessionAuthnVersion: number;
  sessionAuthzVersion: number;
  bindingVersion: number;
  grantVersion: number;
  policyVersion: number;
  requestExpiresAtSeconds: number;
}

/**
 * Session-scoped grant state for reading high-intimacy memory bodies in the
 * Garden admin memory API. Grants are keyed by the requesting admin session
 * identity so one operator's elevation or reveal never leaks bodies to other
 * concurrent admin sessions in the same process. State is in-memory by
 * design: grants are short-lived operator session affordances, and restarting
 * the process fail-closes back to redacted-by-default. A `null` session key
 * (no derivable admin session identity) fail-closes to no grants at all.
 */
export class AdminMemoryBodyGate {
  private readonly grantsBySession = new Map<string, AdminMemorySessionGrants>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options?: { now?: () => number; ttlMs?: number }) {
    this.now = options?.now ?? Date.now;
    this.ttlMs = options?.ttlMs ?? ADMIN_MEMORY_BODY_ACCESS_TTL_MS;
  }

  status(sessionKey: AdminMemorySessionKey): AdminMemoryElevationStatus {
    const expiresAt = this.elevationExpiryFor(sessionKey);
    return {
      elevated: expiresAt !== null,
      ttlMs: this.ttlMs,
      ...(expiresAt !== null ? { expiresAt } : {}),
    };
  }

  isElevated(sessionKey: AdminMemorySessionKey): boolean {
    return this.elevationExpiryFor(sessionKey) !== null;
  }

  elevate(sessionKey: AdminMemorySessionKey): AdminMemoryElevationStatus {
    if (sessionKey === null) {
      // Fail closed: an elevation grant must be keyed to a concrete session.
      throw new Error('Garden memory body elevation requires an admin session identity');
    }
    this.sweepExpiredSessions();
    const grants = this.grantsFor(sessionKey);
    grants.elevationExpiresAt = this.now() + this.ttlMs;
    return this.status(sessionKey);
  }

  dropElevation(sessionKey: AdminMemorySessionKey): AdminMemoryElevationStatus {
    if (sessionKey !== null) {
      const grants = this.grantsBySession.get(sessionKey);
      if (grants) {
        grants.elevationExpiresAt = null;
        this.dropSessionIfEmpty(sessionKey, grants);
      }
    }
    return this.status(sessionKey);
  }

  recordReveal(sessionKey: AdminMemorySessionKey, memoryId: string): void {
    if (sessionKey === null) {
      // Fail closed: a reveal grant must be keyed to a concrete session.
      throw new Error('Garden memory reveal requires an admin session identity');
    }
    this.sweepExpiredSessions();
    this.grantsFor(sessionKey).revealExpiryById.set(memoryId, this.now() + this.ttlMs);
  }

  canReadBody(sessionKey: AdminMemorySessionKey, memory: Pick<PurrMemory, 'id' | 'sensitivity'>): boolean {
    if (!isHighIntimacyMemory(memory)) return true;
    return this.isElevated(sessionKey) || this.isRevealed(sessionKey, memory.id);
  }

  /**
   * Returns the admin view of a memory row: unchanged for public/personal
   * rows or when body access is granted; otherwise metadata is preserved and
   * the body is replaced by an explicit redaction marker. The embedding is
   * stripped from redacted views because it is derived from the body.
   */
  toAdminView(sessionKey: AdminMemorySessionKey, memory: PurrMemory): AdminMemoryView {
    if (this.canReadBody(sessionKey, memory)) return memory;
    const { embedding: _embedding, ...metadata } = memory;
    return {
      ...metadata,
      text: buildMemoryBodyRedactionMarker(memory),
      bodyRedacted: true,
      bodyRedaction: buildBodyRedaction(memory),
    };
  }

  /**
   * Routine fleet view at every sensitivity. The SQL projection has already
   * hidden non-subject rows before IDs and counts are constructed; this
   * second check fails closed if the classification changed before response
   * construction. Only high-intimacy rows receive a reveal binding.
   */
  toFleetAdminView(
    context: Omit<FleetMemoryBodyAuthorizationContext, 'action' | 'resourceMemoryId'
      | 'assurance' | 'requestExpiresAtSeconds'>,
    memory: PurrMemory,
    classification: MemorySubjectClassification,
  ): AdminMemoryView {
    this.assertFleetProjection(context, memory, classification);
    const subjectSafeMemory = this.subjectSafeMemory(memory, context.viewerContactId);
    if (!isHighIntimacyMemory(subjectSafeMemory)) return subjectSafeMemory;
    const redacted = this.toAdminView(null, subjectSafeMemory);
    return {
      ...redacted,
      subjectJitBinding: {
        subjectScopeDigest: memorySubjectScopeDigest({
          companionId: context.companionId,
          memoryId: memory.id,
          viewerContactId: context.viewerContactId,
          viewerRelation: context.viewerRelation,
          classification,
        }),
        memoryRevision: classification.memoryRevision,
        classifierVersion: classification.classifierVersion,
        classifierEvidenceDigest: memorySubjectClassifierEvidenceDigest(classification),
      },
    };
  }

  /**
   * Exercise one already-consumed gateway JIT grant. No reusable in-process
   * fleet grant is minted: the signed request and SQL grant binding authorize
   * exactly this response, while legacy feature-off reveal TTLs stay intact.
   */
  toFleetJitView(
    context: FleetMemoryBodyAuthorizationContext,
    request: MemorySubjectJitRequest,
    memory: PurrMemory,
    classification: MemorySubjectClassification,
  ): AdminMemoryView {
    this.assertFleetProjection(context, memory, classification);
    if (context.resourceMemoryId !== memory.id
      || !Number.isSafeInteger(context.requestExpiresAtSeconds)
      || this.now() >= context.requestExpiresAtSeconds * 1_000
      || request.memoryRevision !== classification.memoryRevision
      || request.classifierVersion !== classification.classifierVersion
      || !timingSafeStringEqual(
        request.classifierEvidenceDigest,
        memorySubjectClassifierEvidenceDigest(classification),
      )
      || !timingSafeStringEqual(request.subjectScopeDigest, memorySubjectScopeDigest({
        companionId: context.companionId,
        memoryId: memory.id,
        viewerContactId: context.viewerContactId,
        viewerRelation: context.viewerRelation,
        classification,
      }))) {
      throw new Error('Memory subject JIT grant does not match the current authorization projection');
    }
    return this.subjectSafeMemory(memory, context.viewerContactId);
  }

  private subjectSafeMemory(memory: PurrMemory, viewerContactId: string): PurrMemory {
    const provenance = memory.provenance ? { ...memory.provenance } : undefined;
    if (provenance) {
      for (const field of [
        'triggerContactId',
        'routedContactId',
        'sourceContactId',
        'subjectContactId',
      ] as const) {
        if (provenance[field] !== undefined && provenance[field] !== viewerContactId) {
          delete provenance[field];
        }
      }
      if (provenance.subjectContactIds) {
        provenance.subjectContactIds = provenance.subjectContactIds
          .filter(contactId => contactId === viewerContactId);
      }
      delete provenance.sourceAuthorId;
      delete provenance.sourceSpeakerName;
    }
    const subjectSafe = {
      ...memory,
      ...(provenance ? { provenance } : {}),
    };
    if (subjectSafe.contactId !== undefined && subjectSafe.contactId !== viewerContactId) {
      delete subjectSafe.contactId;
    }
    return subjectSafe;
  }

  private assertFleetProjection(
    context: Pick<FleetMemoryBodyAuthorizationContext,
      'principalId' | 'browserSessionId' | 'companionId' | 'viewerContactId' | 'viewerRelation'
      | 'authorityGeneration' | 'globalAuthEpoch' | 'sessionAuthnVersion'
      | 'sessionAuthzVersion' | 'bindingVersion' | 'grantVersion' | 'policyVersion'>,
    memory: PurrMemory,
    classification: MemorySubjectClassification,
  ): void {
    const versions = [
      context.authorityGeneration,
      context.globalAuthEpoch,
      context.sessionAuthnVersion,
      context.sessionAuthzVersion,
      context.bindingVersion,
      context.grantVersion,
      context.policyVersion,
    ];
    if (!context.principalId.trim() || !context.browserSessionId.trim()
      || !context.companionId.trim() || !context.viewerContactId.trim()
      || versions.some(version => !Number.isSafeInteger(version) || version < 1)
      || classification.memoryId !== memory.id
      || classification.status !== 'current'
      || classification.classifierVersion !== MEMORY_SUBJECT_CLASSIFIER_VERSION
      || classification.subjectClass !== 'single_contact'
      || classification.subjectContactIds.length !== 1
      || classification.subjectContactIds[0] !== context.viewerContactId) {
      throw new Error('Memory body access requires a current proven single-contact subject');
    }
  }

  private grantsFor(sessionKey: string): AdminMemorySessionGrants {
    const existing = this.grantsBySession.get(sessionKey);
    if (existing) return existing;
    const created: AdminMemorySessionGrants = {
      elevationExpiresAt: null,
      revealExpiryById: new Map(),
    };
    this.grantsBySession.set(sessionKey, created);
    return created;
  }

  private elevationExpiryFor(sessionKey: AdminMemorySessionKey): number | null {
    if (sessionKey === null) return null;
    const grants = this.grantsBySession.get(sessionKey);
    if (!grants || grants.elevationExpiresAt === null) return null;
    if (this.now() >= grants.elevationExpiresAt) {
      grants.elevationExpiresAt = null;
      this.dropSessionIfEmpty(sessionKey, grants);
      return null;
    }
    return grants.elevationExpiresAt;
  }

  private isRevealed(sessionKey: AdminMemorySessionKey, memoryId: string): boolean {
    if (sessionKey === null) return false;
    const grants = this.grantsBySession.get(sessionKey);
    if (!grants) return false;
    const expiresAt = grants.revealExpiryById.get(memoryId);
    if (expiresAt === undefined) return false;
    if (this.now() >= expiresAt) {
      grants.revealExpiryById.delete(memoryId);
      this.dropSessionIfEmpty(sessionKey, grants);
      return false;
    }
    return true;
  }

  private dropSessionIfEmpty(sessionKey: string, grants: AdminMemorySessionGrants): void {
    if (grants.elevationExpiresAt === null && grants.revealExpiryById.size === 0) {
      this.grantsBySession.delete(sessionKey);
    }
  }

  /** Bounds grant-map growth: fully expired sessions are pruned on each new grant. */
  private sweepExpiredSessions(): void {
    const now = this.now();
    for (const [sessionKey, grants] of this.grantsBySession) {
      if (grants.elevationExpiresAt !== null && now >= grants.elevationExpiresAt) {
        grants.elevationExpiresAt = null;
      }
      for (const [memoryId, expiresAt] of grants.revealExpiryById) {
        if (now >= expiresAt) grants.revealExpiryById.delete(memoryId);
      }
      this.dropSessionIfEmpty(sessionKey, grants);
    }
  }
}
