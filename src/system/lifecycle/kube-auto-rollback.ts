// ── Automatic Helm rollback for failed companion self-updates (x5rt.8) ──
//
// The safety net that consumes the x5rt.7 post-rollout validation verdict and
// decides whether a freshly rolled companion container failed and must be rolled
// back. This runs in the operator-job composition (its own Helm transport, no
// agent credentials) as the deploy job's own recovery path — NOT through the
// agent-facing approval boundary, which governs agent-*requested* actions.
//
// The decision honours a hard cross-bead contract from the x5rt.7 dual review:
//
//   1. BIND before trusting. `post-rollout-validation-latest.json` is opt-in and
//      may hold the PRIOR rollout's verdict (persist not wired, or the gate
//      errored before writing). We bind on (release, helmRevision, sourceCommit)
//      against the CURRENT rollout; a mismatch is "no verdict for this rollout"
//      and must NOT be read as health. A stale HEALTHY verdict never suppresses a
//      needed rollback, and a stale FAILED verdict never triggers one.
//
//   2. ACT ONCE PER REVISION. After a rollback, latest.json still holds the
//      FAILED verdict of the rolled-back-from revision. We key the action on
//      (release, fromHelmRevision) and consult the rollback ledger so we never
//      rollback-loop.
//
//   3. WAIVED means the operator owns it. An `overall: 'waived'` verdict is an
//      emergency assertion with zero probe evidence — surface it, never treat it
//      as health and never auto-rollback on it.
//
//   4. ABSENT/ERRORED/STALE = fail-safe, but NOT auto-rollback. Auto-rollback
//      triggers on validation FAILURE for the current rollout, not on validation
//      absence: rolling back an unvalidated-but-possibly-fine deploy is itself
//      destructive. An absent/stale/errored verdict yields "no decision — surface
//      to operator," which crucially still refuses to declare the rollout healthy.

import { isRecord } from '../../shared/utils/types.js';
import type { PostRolloutValidationRecord } from './kube-post-rollout-validation.js';
import { readPostRolloutValidationLatest } from './kube-post-rollout-validation-store.js';
import {
  hasRolledBackFrom,
  readKubeRollbackHistory,
  writeKubeRollbackRecord,
  type KubeRollbackRecord,
} from './kube-rollback-store.js';
import {
  managedRollbackDeploymentNames,
  waitForDeploymentsReady,
  DEFAULT_ROLLBACK_POLL_INTERVAL_MS,
  DEFAULT_ROLLBACK_WAIT_TIMEOUT_MS,
  type KubeHelmRollbackApiPort,
} from './kube-helm-rollback.js';

/** The rollout currently live, whose health the verdict must describe to be trusted. */
export interface CurrentRolloutBinding {
  release: string;
  helmRevision: number;
  sourceCommit: string;
}

export type AutoRollbackSurfaceReason =
  | 'no_verdict'
  | 'binding_mismatch'
  | 'malformed_verdict'
  | 'waived'
  | 'already_acted';

/**
 * Pure decision. The verdict is trusted ONLY when it binds to the current
 * rollout. Ordering matters: waived is checked before healthy (a waived verdict
 * is healthy-by-assertion but must never auto-suppress), and the act-once ledger
 * is consulted before a rollback is authorised.
 */
export type AutoRollbackDecision =
  | {
    kind: 'rollback';
    verdict: PostRolloutValidationRecord;
    fromHelmRevision: number;
    failedChecks: string[];
    reason: string;
  }
  | { kind: 'healthy'; verdict: PostRolloutValidationRecord }
  | { kind: 'surface'; reasonCode: AutoRollbackSurfaceReason; detail: string };

function verdictBindsToRollout(
  verdict: PostRolloutValidationRecord,
  binding: CurrentRolloutBinding,
): boolean {
  return verdict.release === binding.release
    && verdict.helmRevision === binding.helmRevision
    && verdict.sourceCommit === binding.sourceCommit;
}

/**
 * Minimal shape guard over the trusted, system-owned verdict. `readPostRollout…`
 * already throws on unparseable JSON (fail-safe); this catches a well-formed JSON
 * object that is not a verdict so we surface rather than mis-bind on undefined
 * fields.
 */
function isVerdictShape(value: unknown): value is PostRolloutValidationRecord {
  if (!isRecord(value)) return false;
  return typeof value.release === 'string'
    && typeof value.sourceCommit === 'string'
    && typeof value.helmRevision === 'number'
    && typeof value.healthy === 'boolean'
    && (value.overall === 'passed' || value.overall === 'failed' || value.overall === 'waived')
    && (value.recommendedAction === 'none' || value.recommendedAction === 'rollback');
}

/**
 * Decide the automatic rollback action for the current rollout given the latest
 * persisted verdict and the rollback ledger. Never throws; every path returns an
 * explicit decision.
 */
export function decideAutoRollback(
  binding: CurrentRolloutBinding,
  verdict: PostRolloutValidationRecord | null,
  ledger: readonly KubeRollbackRecord[],
): AutoRollbackDecision {
  if (verdict === null) {
    return {
      kind: 'surface',
      reasonCode: 'no_verdict',
      detail: 'no post-rollout verdict recorded for the current rollout',
    };
  }
  if (!isVerdictShape(verdict)) {
    return {
      kind: 'surface',
      reasonCode: 'malformed_verdict',
      detail: 'latest post-rollout verdict is not a recognised validation record',
    };
  }
  if (!verdictBindsToRollout(verdict, binding)) {
    // Stale verdict from a different rollout: do NOT read it as health (a stale
    // HEALTHY must not suppress a needed rollback) and do NOT act on it (a stale
    // FAILED must not trigger one).
    return {
      kind: 'surface',
      reasonCode: 'binding_mismatch',
      detail:
        `latest verdict binds to release=${verdict.release} helmRevision=${verdict.helmRevision} `
        + `sourceCommit=${verdict.sourceCommit}, not the current rollout `
        + `(release=${binding.release} helmRevision=${binding.helmRevision} sourceCommit=${binding.sourceCommit})`,
    };
  }
  // From here the verdict is for THIS rollout.
  if (verdict.overall === 'waived') {
    return {
      kind: 'surface',
      reasonCode: 'waived',
      detail: 'post-rollout verdict is an operator emergency waiver (no probe evidence); operator owns health',
    };
  }
  if (verdict.healthy) {
    return { kind: 'healthy', verdict };
  }
  // Unhealthy verdict for the current rollout → rollback is warranted, unless we
  // already rolled back away from this revision (act-once).
  if (hasRolledBackFrom(ledger, binding.release, binding.helmRevision)) {
    return {
      kind: 'surface',
      reasonCode: 'already_acted',
      detail:
        `a rollback away from release=${binding.release} helmRevision=${binding.helmRevision} `
        + 'is already recorded; not rolling back again (act-once)',
    };
  }
  const failedChecks = Array.isArray(verdict.failedChecks) ? [...verdict.failedChecks] : [];
  return {
    kind: 'rollback',
    verdict,
    fromHelmRevision: binding.helmRevision,
    failedChecks,
    reason: failedChecks.length > 0
      ? `post-rollout validation failed: ${failedChecks.join(', ')}`
      : 'post-rollout validation reported an unhealthy companion',
  };
}

/**
 * Resolve the Helm revision to roll back TO given the failed revision. The
 * operator-job composition supplies this (it owns `helm history`); a fake drives
 * tests. `no_previous_revision` is the no-op case the acceptance criteria call
 * out: the first-ever revision has nothing to roll back to.
 */
export type KubeRollbackTargetResolution =
  | { kind: 'target'; targetRevision: number; targetSourceCommit?: string }
  | { kind: 'no_previous_revision' };

export type AutoRollbackOutcome =
  | { status: 'rolled_back'; record: KubeRollbackRecord }
  | { status: 'rollback_failed'; record: KubeRollbackRecord }
  | { status: 'healthy'; verdict: PostRolloutValidationRecord }
  | { status: 'surfaced'; reasonCode: AutoRollbackSurfaceReason; detail: string }
  | { status: 'no_previous_revision'; detail: string };

export interface AutoRollbackAuditEvent {
  namespace: string;
  release: string;
  currentHelmRevision: number;
  currentSourceCommit: string;
  status: AutoRollbackOutcome['status'];
  detail: string;
  fromHelmRevision?: number;
  targetHelmRevision?: number;
  resultingHelmRevision?: number;
  failedChecks?: string[];
  reasonCode?: AutoRollbackSurfaceReason;
}

export interface ExecuteAutoRollbackOptions {
  namespace: string;
  release: string;
  resourcePrefix: string;
  systemDataDir: string;
  /** The rollout currently live (env-pinned by the operator job for this run). */
  currentRollout: CurrentRolloutBinding;
  api: KubeHelmRollbackApiPort;
  /** Resolves the known-good revision to roll back to (operator job's `helm history`). */
  resolveRollbackTarget: (failedRevision: number) => Promise<KubeRollbackTargetResolution>;
  /** Emitted for every terminal decision (audit trail), including no-op decisions. */
  audit?: (event: AutoRollbackAuditEvent) => Promise<void>;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Evaluate the current rollout against the latest verdict and, when a rollback is
 * warranted and safe (bound, not waived, not already acted, and a previous
 * revision exists), enact it: `helm rollback`, wait for the three Deployments to
 * recover, and record the action on the durable ledger + audit trail. Returns an
 * explicit outcome for every path; the only throws are from the injected API/
 * resolver (an unreadable cluster is not proof of health).
 */
export async function executeAutoRollback(
  options: ExecuteAutoRollbackOptions,
): Promise<AutoRollbackOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_ROLLBACK_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_ROLLBACK_POLL_INTERVAL_MS;

  const emit = async (event: AutoRollbackAuditEvent): Promise<void> => {
    if (options.audit) await options.audit(event);
  };
  const auditBase = {
    namespace: options.namespace,
    release: options.release,
    currentHelmRevision: options.currentRollout.helmRevision,
    currentSourceCommit: options.currentRollout.sourceCommit,
  };

  const verdict = readPostRolloutValidationLatest(options.systemDataDir);
  const ledger = readKubeRollbackHistory(options.systemDataDir);
  const decision = decideAutoRollback(options.currentRollout, verdict, ledger);

  if (decision.kind === 'healthy') {
    await emit({ ...auditBase, status: 'healthy', detail: 'current rollout proved healthy; no rollback' });
    return { status: 'healthy', verdict: decision.verdict };
  }
  if (decision.kind === 'surface') {
    await emit({
      ...auditBase,
      status: 'surfaced',
      reasonCode: decision.reasonCode,
      detail: decision.detail,
    });
    return { status: 'surfaced', reasonCode: decision.reasonCode, detail: decision.detail };
  }

  // decision.kind === 'rollback'
  const target = await options.resolveRollbackTarget(decision.fromHelmRevision);
  if (target.kind === 'no_previous_revision') {
    const detail =
      `no previous Helm revision to roll back to from revision ${decision.fromHelmRevision}; `
      + 'escalating to operator';
    await emit({
      ...auditBase,
      status: 'no_previous_revision',
      detail,
      fromHelmRevision: decision.fromHelmRevision,
      failedChecks: decision.failedChecks,
    });
    return { status: 'no_previous_revision', detail };
  }

  // Target-revision safety invariant. `resolveRollbackTarget` is an injected
  // (currently unimplemented) seam; the rollback surface must defend its own
  // invariant rather than trust the target it is handed. Only ever roll back to
  // a strictly-earlier, positive integer revision — a roll-forward, same-revision,
  // or non-integer/zero/negative "rollback" is a catastrophic failure mode.
  // Fail closed: throw before calling api.rollback (a thrown error propagates as
  // an operator escalation, never a silent proceed), so the unsafe target is
  // never enacted.
  if (
    !Number.isInteger(target.targetRevision)
    || target.targetRevision <= 0
    || target.targetRevision >= decision.fromHelmRevision
  ) {
    throw new Error(
      'Refusing automatic Helm rollback to an unsafe target revision '
      + `${target.targetRevision}: it must be a positive integer strictly earlier `
      + `than the failed revision ${decision.fromHelmRevision}.`,
    );
  }

  const startedAt = now();
  const rollbackResult = await options.api.rollback(
    options.namespace,
    options.release,
    target.targetRevision,
  );
  if (!Number.isSafeInteger(rollbackResult.helmRevision) || rollbackResult.helmRevision <= 0) {
    throw new Error('Automatic Helm rollback returned an invalid resulting release revision.');
  }

  const wait = await waitForDeploymentsReady({
    namespace: options.namespace,
    deploymentNames: managedRollbackDeploymentNames(options.resourcePrefix),
    api: options.api,
    waitTimeoutMs,
    pollIntervalMs,
    now,
    sleep,
  });

  const recordBase = {
    schemaVersion: 1 as const,
    namespace: options.namespace,
    release: options.release,
    trigger: 'automatic' as const,
    fromHelmRevision: decision.fromHelmRevision,
    fromSourceCommit: options.currentRollout.sourceCommit,
    targetHelmRevision: target.targetRevision,
    resultingHelmRevision: rollbackResult.helmRevision,
    reason: decision.reason,
    failedChecks: decision.failedChecks,
    startedAt,
  };

  if (!wait.ready) {
    const detail = `rollback did not recover the release within ${waitTimeoutMs}ms: ${wait.pending}`;
    const record: KubeRollbackRecord = {
      ...recordBase,
      validationResult: 'failed',
      outcome: 'failed',
      completedAt: now(),
      detail,
    };
    // Persist BEFORE surfacing so the act-once ledger records the attempt even on
    // a failed recovery — a failed rollback must not be silently re-fired.
    writeKubeRollbackRecord(options.systemDataDir, record);
    await emit({
      ...auditBase,
      status: 'rollback_failed',
      detail,
      fromHelmRevision: decision.fromHelmRevision,
      targetHelmRevision: target.targetRevision,
      resultingHelmRevision: rollbackResult.helmRevision,
      failedChecks: decision.failedChecks,
    });
    return { status: 'rollback_failed', record };
  }

  const record: KubeRollbackRecord = {
    ...recordBase,
    validationResult: 'passed',
    outcome: 'succeeded',
    completedAt: now(),
  };
  writeKubeRollbackRecord(options.systemDataDir, record);
  await emit({
    ...auditBase,
    status: 'rolled_back',
    detail: decision.reason,
    fromHelmRevision: decision.fromHelmRevision,
    targetHelmRevision: target.targetRevision,
    resultingHelmRevision: rollbackResult.helmRevision,
    failedChecks: decision.failedChecks,
  });
  return { status: 'rolled_back', record };
}
