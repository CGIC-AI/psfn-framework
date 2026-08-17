// ── Pooled intake screening service adapter (psfn-framework-yxz0z.4) ──
//
// Wraps one companion's `IntakeScreeningService` so its async `screen()` calls
// flow through a fleet-wide bounded `ScreeningPool`, keyed by that companion's
// id. The pool preserves per-companion (source-stream) decision/delivery order
// while letting independent companions overlap up to the operator-owned worker
// bound, and isolates per-item crashes/timeouts.
//
// `screenSync()` is NOT pooled: it is the synchronous L1-only path used for
// session-entry recording (no L1.5/L2/L3 awaits, no external calls), so it has
// no latency to bound and no classifier-concurrency concern. Routing it through
// the async pool would force an await on a synchronous result.
//
// FAIL-CLOSED ADAPTER BEHAVIOR
// The underlying `screen()` already fails closed internally (escalation/hold
// failures route to a quarantine decision and, in enforce mode, withhold the
// content). The pool adds NEW failure modes the underlying service cannot see:
// caller cancellation, a hard whole-item deadline, and worker isolation. Under
// those the adapter synthesizes a fail-closed `IntakeScreeningResult`:
//   - enforce mode: content is withheld (the fixed placeholder) and the
//     decision is 'quarantine' — the item is never delivered unscreened.
//   - shadow mode: the original content still passes (shadow is observe-only),
//     but the envelope records the screening-undecided quarantine decision so
//     the operator sees the miss in audit.
// The synthesized result writes NO durable quarantine hold: screening did not
// complete, so there is nothing for the Garden review queue to release. The
// miss is surfaced through the same `onFailClosed` channel the service uses.

import { createHash } from 'node:crypto';
import type { IntakePolicyConfig } from '../../../system/config/intake-policy-config.js';
import {
  createIntakeEnvelope,
  postScreeningStateForDecision,
  snapshotIntakeEnvelope,
  transitionIntakeEnvelope,
  type IntakeDecision,
  type IntakeEnvelope,
  type IntakeEnvelopeSnapshot,
  type IntakeEnvelopeSubject,
  type IntakeSourceClass,
  type IntakeSourceRiskTier,
} from '../../../shared/contracts/intake-envelope.js';
import {
  renderIntakeWithheldContentPlaceholder,
  type IntakeScreeningInput,
  type IntakeScreeningResult,
  type IntakeScreeningService,
  type IntakeScreeningServiceOptions,
} from '../../../core/cogsec/intake/screening.js';
import type { IntakeL1ScanReport } from '../../../core/cogsec/intake/scanners/index.js';
import { COGSEC_DECISION_REASON_MAX_CHARS } from '../../../core/cogsec/intake/screening-envelope-policy.js';
import {
  cogSecVectorForProvenance,
  resolveCogSecProvenanceClass,
  resolveCogSecSurfacePosture,
  type CogSecMode,
  type IntakeEnforcementPosture,
} from '../../../shared/contracts/cogsec-mode.js';
import {
  ScreeningPoolCancelledError,
  ScreeningPoolDeadlineError,
  ScreeningPoolDisposedError,
  type ScreeningPool,
} from './screening-pool.js';

export interface PooledIntakeScreeningServiceOptions {
  /** The companion's underlying screening service (own classifier + store). */
  readonly underlying: IntakeScreeningService;
  /** Fleet-wide pool; the adapter keys every item by `streamKey`. */
  readonly pool: ScreeningPool;
  /** Source-stream key — the companion id this service routes for. */
  readonly streamKey: string;
  /** Used only to resolve a fail-closed envelope's base source risk tier. */
  readonly policy: IntakePolicyConfig;
  /** Whole-item deadline (queue wait + service) for pooled screen() calls. */
  readonly deadlineMs?: number;
  readonly now?: () => number;
  /** Mirrors the underlying service's fail-closed observer. */
  readonly onFailClosed?: IntakeScreeningServiceOptions['onFailClosed'];
}

function buildUnpersistedContentRef(text: string): {
  store: string;
  ref: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
} {
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    store: 'unpersisted',
    ref: `sha256:${sha256}`,
    sha256,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    mediaType: 'text/plain',
  };
}

/**
 * Synthesizes a fail-closed screening result for a pool-level failure (caller
 * cancellation, hard deadline, pool disposal, or an isolated worker crash).
 * Mirrors the underlying service's quarantine decision shape so downstream sink
 * gates and audit read it identically, but writes no durable quarantine hold.
 */
export function synthesizeFailClosedScreeningResult(
  text: string,
  input: IntakeScreeningInput,
  mode: 'shadow' | 'enforce',
  globalMode: CogSecMode,
  reason: string,
  now: () => number,
): IntakeScreeningResult {
  const atMs = input.atMs ?? now();
  const sourceClass: IntakeSourceClass = input.sourceClass;
  // Conservative base tier (no source-list adjustment): a fail-closed outcome
  // must never silently TRUST an item the pool could not finish screening.
  const sourceRiskTier: IntakeSourceRiskTier = 'hostile';
  const withheld = mode === 'enforce';
  const decision: IntakeDecision = {
    action: 'quarantine',
    reason: reason.slice(0, COGSEC_DECISION_REASON_MAX_CHARS),
    decidedBy: 'screening',
    decidedAtMs: atMs,
  };

  let envelope: IntakeEnvelope = createIntakeEnvelope({
    sourceClass,
    sourceRiskTier,
    contentRef: buildUnpersistedContentRef(text),
    origin: input.origin,
    atMs,
  });
  envelope = transitionIntakeEnvelope(envelope, {
    to: 'screened',
    actor: 'gateway:intake-screening-pool',
    reason: decision.reason,
    atMs,
    decision,
    riskLabels: [],
    scores: {},
    extractedFields: {
      'screening_pool.fail_closed': reason.slice(0, COGSEC_DECISION_REASON_MAX_CHARS),
    },
  });
  envelope = transitionIntakeEnvelope(envelope, {
    to: postScreeningStateForDecision('quarantine'),
    actor: 'gateway:intake-screening-pool',
    reason: 'routed per pool fail-closed screening decision',
    atMs,
  });

  const subject: IntakeEnvelopeSubject = input.subject ?? { kind: 'body' };
  const snapshot: IntakeEnvelopeSnapshot = snapshotIntakeEnvelope(envelope, subject, mode);
  const effectiveText = withheld ? renderIntakeWithheldContentPlaceholder() : text;
  const provenance = resolveCogSecProvenanceClass({
    sourceClass,
    ...(input.structuralProvenance !== undefined
      ? { structuralProvenance: input.structuralProvenance }
      : {}),
  });

  // A coherent empty L1 report so callers that read `report` (marking /
  // sanitization paths) get a clean no-findings scan rather than a null.
  const report: IntakeL1ScanReport = {
    scope: input.scope,
    truncated: false,
    riskLabels: [],
    scores: {},
    results: [],
    sanitizedText: text,
    sanitizedDiffers: false,
    extractedFields: {},
    scannerErrors: [],
    elapsedMs: 0,
 };

  return {
    envelope,
    snapshot,
    report,
    action: 'quarantine',
    mode,
    globalMode,
    cogsecVector: cogSecVectorForProvenance(provenance, sourceClass),
    observability: {
      envelopeId: envelope.id,
      sourceClass,
      sourceRiskTier,
      state: envelope.state,
      action: 'quarantine',
      riskLabels: [],
      scores: {},
      priorVerdicts: {},
      semanticTrace: {
        l2: { status: 'failed_closed', reason: 'screening pool failed before completion' },
        l3: { status: 'not_run', reason: 'screening pool failed before completion' },
      },
    },
    effectiveText,
    withheld,
  };
}

function describePoolFailure(error: unknown): string {
  if (error instanceof ScreeningPoolDeadlineError) {
    return 'screening-pool-deadline';
  }
  if (error instanceof ScreeningPoolCancelledError) {
    return 'screening-pool-cancelled';
  }
  if (error instanceof ScreeningPoolDisposedError) {
    return 'screening-pool-disposed';
  }
  if (error instanceof Error) return `screening-pool-worker-crash:${error.message}`;
  return 'screening-pool-worker-crash';
}

/**
 * Wraps an `IntakeScreeningService` so `screen()` is scheduled through a
 * fleet-wide bounded pool. Returns a full `IntakeScreeningService` so it is a
 * drop-in replacement at every `screeningFor(companionId)` call site.
 */
export function createPooledIntakeScreeningService(
  options: PooledIntakeScreeningServiceOptions,
): IntakeScreeningService {
  const { underlying, pool, streamKey, policy } = options;
  const mode = underlying.mode;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? policy.screeningPool.itemDeadlineMs;

  return {
    mode,
    globalMode: underlying.globalMode,
    async screen(text, input: IntakeScreeningInput): Promise<IntakeScreeningResult> {
      try {
        return await pool.run(
          streamKey,
          () => underlying.screen(text, input),
          { deadlineMs },
        );
      } catch (error) {
        const reason = describePoolFailure(error);
        let failureMode: IntakeEnforcementPosture = mode;
        if (input.surface) {
          const surfacePosture = resolveCogSecSurfacePosture(
            policy.surfacePostures,
            input.surface,
          );
          failureMode = surfacePosture.enforces ? 'enforce' : 'shadow';
        }
        options.onFailClosed?.({
          stage: 'escalation',
          sourceClass: input.sourceClass,
          error: reason,
          timestamp: input.atMs ?? now(),
        });
        return synthesizeFailClosedScreeningResult(
          text,
          input,
          failureMode,
          underlying.globalMode,
          reason,
          now,
        );
      }
    },
    screenSync(text, input: IntakeScreeningInput): IntakeScreeningResult {
      // Sync L1-only path is never pooled: no await, no classifier concurrency,
      // no latency to bound. The underlying service already rejects screenSync
      // when an async scorer/escalation is configured.
      return underlying.screenSync(text, input);
    },
  };
}
