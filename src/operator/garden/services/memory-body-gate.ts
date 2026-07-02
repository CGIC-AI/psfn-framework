import type { PurrMemory } from '../../../faculties/memory/types.js';
import { isHighIntimacySensitivityLevel } from '../../../system/trust/types.js';
import type {
  AdminMemoryBodyRedaction,
  AdminMemoryElevationStatus,
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

/**
 * Session-scoped grant state for reading high-intimacy memory bodies in the
 * Garden admin memory API. State is in-memory by design: grants are
 * short-lived operator session affordances, and restarting the process
 * fail-closes back to redacted-by-default.
 */
export class AdminMemoryBodyGate {
  private elevationExpiresAt: number | null = null;
  private readonly revealExpiryById = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options?: { now?: () => number; ttlMs?: number }) {
    this.now = options?.now ?? Date.now;
    this.ttlMs = options?.ttlMs ?? ADMIN_MEMORY_BODY_ACCESS_TTL_MS;
  }

  status(): AdminMemoryElevationStatus {
    const elevated = this.isElevated();
    return {
      elevated,
      ttlMs: this.ttlMs,
      ...(elevated && this.elevationExpiresAt !== null ? { expiresAt: this.elevationExpiresAt } : {}),
    };
  }

  isElevated(): boolean {
    if (this.elevationExpiresAt === null) return false;
    if (this.now() >= this.elevationExpiresAt) {
      this.elevationExpiresAt = null;
      return false;
    }
    return true;
  }

  elevate(): AdminMemoryElevationStatus {
    this.elevationExpiresAt = this.now() + this.ttlMs;
    return this.status();
  }

  dropElevation(): AdminMemoryElevationStatus {
    this.elevationExpiresAt = null;
    return this.status();
  }

  recordReveal(memoryId: string): void {
    this.revealExpiryById.set(memoryId, this.now() + this.ttlMs);
  }

  private isRevealed(memoryId: string): boolean {
    const expiresAt = this.revealExpiryById.get(memoryId);
    if (expiresAt === undefined) return false;
    if (this.now() >= expiresAt) {
      this.revealExpiryById.delete(memoryId);
      return false;
    }
    return true;
  }

  canReadBody(memory: Pick<PurrMemory, 'id' | 'sensitivity'>): boolean {
    if (!isHighIntimacyMemory(memory)) return true;
    return this.isElevated() || this.isRevealed(memory.id);
  }

  /**
   * Returns the admin view of a memory row: unchanged for public/personal
   * rows or when body access is granted; otherwise metadata is preserved and
   * the body is replaced by an explicit redaction marker. The embedding is
   * stripped from redacted views because it is derived from the body.
   */
  toAdminView(memory: PurrMemory): AdminMemoryView {
    if (this.canReadBody(memory)) return memory;
    const { embedding: _embedding, ...metadata } = memory;
    return {
      ...metadata,
      text: buildMemoryBodyRedactionMarker(memory),
      bodyRedacted: true,
      bodyRedaction: buildBodyRedaction(memory),
    };
  }
}
