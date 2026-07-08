import type { PurrMemory } from '../../../faculties/memory/types.js';
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
