// ── Cognition Intake Firewall: quarantined-artifact read guard (hrmrq.54) ──
//
// Closes the containment bypass where a quarantined document's raw bytes were
// one fs.read away: the intake screening withholds the content from the
// prompt, but the parsed document and its sidecar still sit on disk, and a
// read seam that serves those paths hands the quarantined content straight
// back into the turn.
//
// The guard is the ONE decision point read seams consult before serving file
// content. It resolves the requested path against the quarantine store's
// registered artifact paths (quarantine-store.ts, registered at hold time):
//
// - Released/discard-resolved-and-consumable entries do not block: once a
//   human decision put the envelope in a sink-consumable state the artifact
//   is operator-cleared.
// - Any other match records an attempted access on the entry (operator-visible
//   in the Garden Cognitive Security queue — a bypass attempt is never
//   invisible) and, in enforce mode, withholds the read: the caller must
//   return the fixed quarantine notice instead of content.
// - Shadow mode observes only: the attempt is recorded and logged, the read
//   proceeds (the content was delivered at intake anyway) — same observe-only
//   contract as the rest of the firewall.
//
// A failed audit write is logged and the verdict still fails closed —
// an audit failure must never turn into a content release.

import { realpathSync } from 'node:fs';
import { createComponentLogger } from '../../../shared/logger.js';
import { isIntakeSinkConsumableState } from '../../../shared/contracts/intake-envelope.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../intake-firewall-notice-templates.js';
import {
  normalizeQuarantineArtifactPath,
  type IntakeQuarantineAccessAttemptInput,
  type IntakeQuarantineEntry,
} from './quarantine-store.js';

const log = createComponentLogger('QuarantinedArtifactGuard');

/** The store surface the guard needs (structural subset of IntakeQuarantineStore). */
export interface QuarantinedArtifactPathPort {
  findByArtifactPath(path: string): IntakeQuarantineEntry | undefined;
  recordAccessAttempt(input: IntakeQuarantineAccessAttemptInput): IntakeQuarantineEntry;
  /** Registered artifact paths of entries not in a sink-consumable state. */
  listActiveArtifactPaths(): string[];
}

export type QuarantinedArtifactCheckResult =
  | { withheld: false }
  | {
    withheld: true;
    /** The envelope/entry id backing the withhold (Garden queue reference). */
    envelopeId: string;
    /** The fixed htm9.12 withheld-content notice to return instead of content. */
    noticeText: string;
  };

export interface QuarantinedArtifactReadGuard {
  /**
   * Check one read of `path`. `via` is the auditable access seam
   * (e.g. 'gateway:fs.read'). Never throws: audit failures are logged and the
   * verdict still fails closed.
   */
  check(path: string, context: { via: string }): QuarantinedArtifactCheckResult;
  /**
   * The physical deny set for sandbox launches (hrmrq.54 shell seam): every
   * registered artifact path of a not-operator-released entry. Enforce mode
   * THROWS when the store cannot enumerate — a sandbox that cannot know what
   * to mask must not launch (fail closed). Shadow mode always returns []
   * (observe-only: nothing is physically denied).
   */
  listEnforcedArtifactPaths(): string[];
}

export interface QuarantinedArtifactReadGuardOptions {
  store: QuarantinedArtifactPathPort;
  /** Current firewall mode; 'shadow' observes and records but never withholds. */
  mode: 'shadow' | 'enforce';
  now?: () => number;
}

function lookupEntry(
  store: QuarantinedArtifactPathPort,
  path: string,
): IntakeQuarantineEntry | undefined {
  const direct = store.findByArtifactPath(path);
  if (direct) return direct;
  // Symlink robustness: registration stores resolve()-normalized paths; a
  // read that reaches the same file through a symlinked prefix must not slip
  // past the gate.
  try {
    const canonical = realpathSync(path);
    if (canonical !== normalizeQuarantineArtifactPath(path)) {
      return store.findByArtifactPath(canonical);
    }
  } catch {
    // Missing file or unresolvable path: nothing further to match against.
  }
  return undefined;
}

export function createQuarantinedArtifactReadGuard(
  options: QuarantinedArtifactReadGuardOptions,
): QuarantinedArtifactReadGuard {
  const { store, mode } = options;
  const now = options.now ?? Date.now;

  return {
    listEnforcedArtifactPaths(): string[] {
      if (mode !== 'enforce') return [];
      // Throws propagate deliberately: an unenumerable deny set must fail the
      // sandbox launch, never silently launch with the artifacts readable.
      return store.listActiveArtifactPaths();
    },

    check(path: string, context: { via: string }): QuarantinedArtifactCheckResult {
      let entry: IntakeQuarantineEntry | undefined;
      try {
        entry = lookupEntry(store, path);
      } catch (error) {
        // A broken quarantine store cannot prove the path is safe: fail
        // closed in enforce mode rather than serving possibly-held content.
        log.error('Quarantined-artifact lookup failed; failing closed in enforce mode', {
          path,
          via: context.via,
          error: error instanceof Error ? error.message : String(error),
        });
        if (mode === 'enforce') {
          return {
            withheld: true,
            envelopeId: 'unknown',
            noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent,
          };
        }
        return { withheld: false };
      }
      if (!entry) return { withheld: false };
      if (isIntakeSinkConsumableState(entry.envelope.state)) {
        // Operator-released: the artifact is cleared for reads.
        return { withheld: false };
      }

      // Attempted access to a not-released quarantined artifact: always
      // audit (operator-visible on the queue entry), regardless of mode.
      try {
        store.recordAccessAttempt({
          id: entry.id,
          path,
          via: context.via,
          atMs: now(),
        });
      } catch (error) {
        log.error('Failed to record quarantined-artifact access attempt; verdict still applies', {
          entryId: entry.id,
          path,
          via: context.via,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (mode !== 'enforce') {
        log.warn('Shadow mode: quarantined-artifact read observed (not withheld)', {
          entryId: entry.id,
          envelopeState: entry.envelope.state,
          path,
          via: context.via,
        });
        return { withheld: false };
      }

      log.warn('Quarantined-artifact read withheld', {
        entryId: entry.id,
        envelopeState: entry.envelope.state,
        path,
        via: context.via,
      });
      return {
        withheld: true,
        envelopeId: entry.id,
        noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent,
      };
    },
  };
}
