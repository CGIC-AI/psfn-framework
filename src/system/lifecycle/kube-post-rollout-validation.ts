// ── Post-rollout validation gate for kube companion container updates ──
//
// After the guarded deploy pipeline (x5rt.6) performs the single live-mutating
// `helm_upgrade` stage, THIS gate is the validation that runs against the live-
// rolled companion. Helm reporting "deployed" is insufficient: a rollout can
// report ready while the new container is broken (bad model route, missing
// runtime tool, crash-looping sidecar, poisoned session writes). The gate
// automates the remote pass criteria proven by the 2026-07-06 rev-8 hand run
// into a structured pass/fail verdict that the sibling Helm-rollback surface
// (x5rt.8) consumes to decide whether to roll back.
//
// Fail-closed safety semantics (the invariant that makes the sibling rollback
// correct): a companion that cannot PROVE it is healthy is not healthy. Any
// check that is inconclusive, errors, or times out is treated as a FAIL, never
// a silent pass. The gate is considered healthy ONLY when every required check
// passes, or the run is an explicitly justified emergency waiver.
//
// Reuse, not reinvention:
//   - tool conformance consumes the x5rt.3 harness result contract
//     (ToolConformanceRunResult) fetched from the NEW pod (post_rollout trigger);
//   - the log/diagnosis scan consumes the x5rt.2 bounded, redacted runtime
//     diagnostics snapshot (RuntimeDiagnosticsSnapshot).
// Live-touching probes (rollout status, Garden health, /v1/models, pgvector,
// Redis, chat-turn) are delegated to an injected {@link PostRolloutValidationRunner}
// so the whole gate is testable without a cluster; live k3d coverage is x5rt.9.

import {
  isKubeDnsLabel,
  isKubeSourceRevision,
  isPinnedKubeImageReference,
} from './kube-self-management.js';
import type { ToolConformanceRunResult } from '../../core/agent/tool-conformance/types.js';
import type { RuntimeDiagnosticsSnapshot } from '../../shared/diagnostics/runtime-diagnostics.js';

export const POST_ROLLOUT_VALIDATION_SCHEMA_VERSION = 1 as const;

/**
 * The required post-rollout checks. Order is the run order and the record order.
 * `tool_conformance` is the only check that may be explicitly skipped (with a
 * recorded reason) per the acceptance criteria; every other check is strictly
 * required and a non-pass verdict fails the gate.
 */
export const POST_ROLLOUT_CHECK_IDS = [
  'rollout_status',
  'garden_health',
  'model_route',
  'pgvector',
  'redis_ping',
  'agent_readiness',
  'chat_turn_probe',
  'tool_conformance',
  'log_scan',
] as const;
export type PostRolloutCheckId = typeof POST_ROLLOUT_CHECK_IDS[number];

const CHECK_TITLES: Record<PostRolloutCheckId, string> = {
  rollout_status: 'Agent/gateway/garden Deployments rolled to the new revision and ready',
  garden_health: 'Garden /health reports ok with admin transport up',
  model_route: 'Gateway /v1/models includes the expected companion model route',
  pgvector: 'Postgres pgvector extension present',
  redis_ping: 'Redis responds to PING with PONG',
  agent_readiness: 'Agent emitted Ready, no CrashLoopBackOff, running image matches the target tag/revision',
  chat_turn_probe: 'Two-turn gateway smoke: served provider matches request and the turn record is residue-free',
  tool_conformance: 'Tool-surface conformance harness (x5rt.3) passed on the new pod',
  log_scan: 'Bounded diagnostics scan (x5rt.2) shows no crash/owner-file/tool-wiring failures',
};

/** Per-check verdict. `inconclusive` and `skipped` are NOT passes for a required check. */
export type PostRolloutCheckVerdict = 'pass' | 'fail' | 'inconclusive' | 'skipped';

export interface PostRolloutCheckResult {
  id: PostRolloutCheckId;
  title: string;
  /** Whether this check gates the overall verdict. Only `tool_conformance` may be non-required (explicit skip). */
  required: boolean;
  verdict: PostRolloutCheckVerdict;
  checkedAt: number;
  /** Short, secret-free human detail. */
  detail?: string;
  /** Small, secret-free structured evidence recorded verbatim. */
  evidence?: Record<string, unknown>;
}

/** Uniform raw result a runner probe returns; the orchestrator classifies fail-closed. */
export interface RawCheckResult {
  verdict: 'pass' | 'fail' | 'inconclusive';
  detail?: string;
  evidence?: Record<string, unknown>;
}

export interface PostRolloutValidationContext {
  namespace: string;
  release: string;
  sourceCommit: string;
  imageReference: string;
  imageRevisionLabel: string;
  helmRevision: number;
}

/** A skipped conformance decision carries a mandatory, non-empty reason. */
export interface ToolConformanceSkipped {
  skippedReason: string;
}

function isConformanceSkipped(
  value: ToolConformanceRunResult | ToolConformanceSkipped,
): value is ToolConformanceSkipped {
  return typeof (value as ToolConformanceSkipped).skippedReason === 'string';
}

/**
 * Side-effecting seam. Every method touches the live-rolled release; the agent
 * runtime never supplies this runner (credential separation, x5rt.10) — the
 * operator-job composition carries its own transport. Injected so the gate is
 * testable with fakes; live coverage is x5rt.9.
 */
export interface PostRolloutValidationRunner {
  checkRolloutStatus(context: PostRolloutValidationContext): Promise<RawCheckResult>;
  checkGardenHealth(context: PostRolloutValidationContext): Promise<RawCheckResult>;
  checkModelRoute(context: PostRolloutValidationContext): Promise<RawCheckResult>;
  checkPgVector(context: PostRolloutValidationContext): Promise<RawCheckResult>;
  checkRedis(context: PostRolloutValidationContext): Promise<RawCheckResult>;
  checkAgentReadiness(context: PostRolloutValidationContext): Promise<RawCheckResult>;
  checkChatTurnProbe(context: PostRolloutValidationContext): Promise<RawCheckResult>;
  /** x5rt.3 conformance result from the NEW pod, or an explicit skip with a reason. */
  fetchToolConformance(
    context: PostRolloutValidationContext,
  ): Promise<ToolConformanceRunResult | ToolConformanceSkipped>;
  /** x5rt.2 bounded, redacted diagnostics snapshot from the NEW pod. */
  fetchDiagnostics(context: PostRolloutValidationContext): Promise<RuntimeDiagnosticsSnapshot>;
}

export type PostRolloutValidationTrigger = 'deploy_pipeline' | 'manual';

export interface PostRolloutValidationPlan {
  namespace: string;
  release: string;
  sourceCommit: string;
  imageReference: string;
  imageRevisionLabel: string;
  helmRevision: number;
  trigger?: PostRolloutValidationTrigger;
  /**
   * A DOCUMENTED emergency waiver: the gate is treated as healthy even though the
   * checks did not run, and the justification is recorded. Fail-closed: an empty
   * justification is rejected.
   */
  emergencyWaiver?: { justification: string };
}

export interface RunPostRolloutValidationOptions {
  runner: PostRolloutValidationRunner;
  now?: () => number;
  /**
   * Post-rollout tool-validation-failure count that fails the log scan. A freshly
   * rolled, healthy pod should have zero; default 1 (any failure fails the scan).
   */
  toolValidationFailureThreshold?: number;
  /** Max sanitized log records copied into the verdict record for rollback debugging. */
  maxLogRecords?: number;
}

export interface PostRolloutValidationLogContext {
  status: 'available' | 'unavailable';
  reason?: string;
  counts?: { warn: number; error: number };
  toolValidationFailures?: number;
  /** Already sanitized by the x5rt.2 diagnostics surface; copied verbatim, bounded. */
  records?: Array<{ observedAt: number; level: 'warn' | 'error'; component?: string; message: string }>;
}

export interface PostRolloutValidationRecord {
  schemaVersion: typeof POST_ROLLOUT_VALIDATION_SCHEMA_VERSION;
  namespace: string;
  release: string;
  sourceCommit: string;
  imageReference: string;
  imageRevisionLabel: string;
  helmRevision: number;
  trigger: PostRolloutValidationTrigger;
  startedAt: number;
  completedAt: number;
  overall: 'passed' | 'failed' | 'waived';
  /** The single pass/fail signal x5rt.8 reads. */
  healthy: boolean;
  /** Explicit remediation signal for the rollback surface. */
  recommendedAction: 'none' | 'rollback';
  emergencyWaiver?: { justification: string };
  checks: PostRolloutCheckResult[];
  /** Ids of required checks that did not pass. Empty on a healthy or waived verdict. */
  failedChecks: PostRolloutCheckId[];
  /** Sanitized log context for rollback/debugging (reuse x5rt.2). */
  logContext?: PostRolloutValidationLogContext;
}

/** Raised only for gate-level input faults (an invalid plan), never per-check failures. */
export class PostRolloutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostRolloutValidationError';
  }
}

const DEFAULT_MAX_LOG_RECORDS = 10;

function assertValidPlan(plan: PostRolloutValidationPlan): void {
  if (!isKubeDnsLabel(plan.namespace) || !isKubeDnsLabel(plan.release)) {
    throw new PostRolloutValidationError(
      'Post-rollout validation namespace and release must be DNS labels.',
    );
  }
  if (!isKubeSourceRevision(plan.sourceCommit) || !isKubeSourceRevision(plan.imageRevisionLabel)) {
    throw new PostRolloutValidationError(
      'Post-rollout validation source commit and image revision label must be exact 40-character Git revisions.',
    );
  }
  if (!isPinnedKubeImageReference(plan.imageReference)) {
    throw new PostRolloutValidationError(
      'Post-rollout validation image reference must be an exact, non-floating pinned tag.',
    );
  }
  if (!Number.isSafeInteger(plan.helmRevision) || plan.helmRevision <= 0) {
    throw new PostRolloutValidationError(
      'Post-rollout validation requires a positive Helm release revision.',
    );
  }
  if (plan.emergencyWaiver !== undefined
    && (typeof plan.emergencyWaiver.justification !== 'string'
      || plan.emergencyWaiver.justification.trim().length === 0)) {
    throw new PostRolloutValidationError(
      'Post-rollout validation emergency waiver requires a non-empty justification.',
    );
  }
}

/**
 * Classify an x5rt.3 conformance result into a post-rollout check. Included
 * results gate the verdict (pass iff at least one probe ran and every probe
 * passed); an explicit skip with a recorded reason is non-gating but recorded.
 */
export function classifyToolConformance(
  result: ToolConformanceRunResult | ToolConformanceSkipped,
  checkedAt: number,
): PostRolloutCheckResult {
  const base = {
    id: 'tool_conformance' as const,
    title: CHECK_TITLES.tool_conformance,
    checkedAt,
  };
  if (isConformanceSkipped(result)) {
    const reason = result.skippedReason.trim();
    if (reason.length === 0) {
      // Fail-closed: a skip without a reason is not an acceptable skip.
      return {
        ...base,
        required: true,
        verdict: 'fail',
        detail: 'tool conformance skipped without a recorded reason',
      };
    }
    return {
      ...base,
      required: false,
      verdict: 'skipped',
      detail: reason,
    };
  }
  const total = result.results.length;
  const failing = result.results.filter(entry => !entry.ok);
  const passed = total > 0 && failing.length === 0;
  const evidence: Record<string, unknown> = {
    trigger: result.trigger,
    ranAt: result.ranAt,
    total,
    failed: failing.length,
    ...(failing.length > 0
      ? {
        failingProbes: failing.slice(0, 10).map(entry => ({
          tool: entry.toolName,
          probeKind: entry.probeKind,
          ...(entry.action ? { action: entry.action } : {}),
          ...(entry.classification ? { classification: entry.classification } : {}),
        })),
      }
      : {}),
  };
  if (passed) {
    return { ...base, required: true, verdict: 'pass', evidence };
  }
  return {
    ...base,
    required: true,
    verdict: 'fail',
    detail: total === 0
      ? 'conformance harness reported zero probes'
      : `${failing.length}/${total} conformance probes failed`,
    evidence,
  };
}

const CRITICAL_LOG_SIGNATURES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'crash_loop_backoff', pattern: /crashloopbackoff/i },
  { id: 'startup_owner_file_error', pattern: /owner[\s-]?file|startup.*owner|ownerfile/i },
  { id: 'missing_file_enoent', pattern: /\bENOENT\b/ },
  { id: 'missing_runtime_tool', pattern: /missing (runtime )?tool|tool .*(not (found|registered)|unavailable)/i },
  { id: 'tool_wiring_failure', pattern: /toolwiringvalidator|tool wiring/i },
];

/**
 * Scan the x5rt.2 diagnostics snapshot for the failure signatures that make a
 * fresh rollout unhealthy. The snapshot is already sanitized by the diagnostics
 * surface; records are copied without further transformation. Fails on any
 * critical error-level signature or a tool-validation-failure count at/above the
 * threshold (a freshly rolled pod should have none).
 */
export function classifyLogScan(
  snapshot: RuntimeDiagnosticsSnapshot,
  checkedAt: number,
  options: { toolValidationFailureThreshold: number; maxLogRecords: number },
): PostRolloutCheckResult {
  const base = {
    id: 'log_scan' as const,
    title: CHECK_TITLES.log_scan,
    required: true,
    checkedAt,
  };
  const records: Array<{ observedAt: number; level: 'warn' | 'error'; component?: string; message: string }> = [];
  for (const record of snapshot.agentLog.records) {
    records.push({
      observedAt: record.observedAt,
      level: record.level,
      ...(record.component ? { component: record.component } : {}),
      message: record.message,
    });
  }
  if (snapshot.fileLogs.status === 'available') {
    for (const record of snapshot.fileLogs.records) {
      records.push({
        observedAt: record.observedAt,
        level: record.level,
        ...(record.component ? { component: record.component } : {}),
        message: record.message,
      });
    }
  }

  const matchedSignatures = new Set<string>();
  for (const record of records) {
    if (record.level !== 'error') continue;
    for (const signature of CRITICAL_LOG_SIGNATURES) {
      if (signature.pattern.test(record.message)) matchedSignatures.add(signature.id);
    }
  }
  const toolValidationFailures = snapshot.toolValidationFailures.total;
  const errorCount = records.filter(record => record.level === 'error').length;
  const warnCount = records.filter(record => record.level === 'warn').length;

  const evidence: Record<string, unknown> = {
    errorCount,
    warnCount,
    toolValidationFailures,
    ...(matchedSignatures.size > 0 ? { matchedSignatures: [...matchedSignatures].sort() } : {}),
  };

  const failedOnSignatures = matchedSignatures.size > 0;
  const failedOnToolValidation = toolValidationFailures >= options.toolValidationFailureThreshold;
  if (failedOnSignatures || failedOnToolValidation) {
    const reasons: string[] = [];
    if (failedOnSignatures) reasons.push(`critical log signatures: ${[...matchedSignatures].sort().join(', ')}`);
    if (failedOnToolValidation) reasons.push(`${toolValidationFailures} tool-validation failure(s)`);
    return { ...base, verdict: 'fail', detail: reasons.join('; '), evidence };
  }
  return { ...base, verdict: 'pass', evidence };
}

function buildLogContext(
  snapshot: RuntimeDiagnosticsSnapshot,
  maxLogRecords: number,
): PostRolloutValidationLogContext {
  const records: Array<{ observedAt: number; level: 'warn' | 'error'; component?: string; message: string }> = [];
  const push = (record: { observedAt: number; level: 'warn' | 'error'; component?: string; message: string }): void => {
    records.push({
      observedAt: record.observedAt,
      level: record.level,
      ...(record.component ? { component: record.component } : {}),
      message: record.message,
    });
  };
  for (const record of snapshot.agentLog.records) push(record);
  if (snapshot.fileLogs.status === 'available') {
    for (const record of snapshot.fileLogs.records) push(record);
  }
  // Errors first, then most recent, so the bounded slice keeps the useful lines.
  records.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'error' ? -1 : 1;
    return b.observedAt - a.observedAt;
  });
  return {
    status: 'available',
    counts: {
      warn: records.filter(record => record.level === 'warn').length,
      error: records.filter(record => record.level === 'error').length,
    },
    toolValidationFailures: snapshot.toolValidationFailures.total,
    records: records.slice(0, Math.max(0, maxLogRecords)),
  };
}

interface CheckSpec {
  id: Exclude<PostRolloutCheckId, 'tool_conformance' | 'log_scan'>;
  run(context: PostRolloutValidationContext): Promise<RawCheckResult>;
}

/**
 * Run a single live probe fail-closed: a thrown/rejected probe is recorded as an
 * `inconclusive` check with the error message (NOT swallowed — it is explicit in
 * the record and fails the gate). All checks run to completion so the verdict
 * record carries full evidence for rollback debugging.
 */
async function runOneCheck(spec: CheckSpec, context: PostRolloutValidationContext, checkedAt: number): Promise<PostRolloutCheckResult> {
  const base = { id: spec.id, title: CHECK_TITLES[spec.id], required: true, checkedAt };
  let raw: RawCheckResult;
  try {
    raw = await spec.run(context);
  } catch (error) {
    return {
      ...base,
      verdict: 'inconclusive',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ...base,
    verdict: raw.verdict,
    ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
    ...(raw.evidence !== undefined ? { evidence: raw.evidence } : {}),
  };
}

/**
 * Execute the post-rollout validation gate. Always resolves with a verdict
 * record (per-check failures are data, not exceptions); only an invalid plan
 * throws {@link PostRolloutValidationError}. Fail-closed: the gate is healthy
 * only when every required check passes, or the run is an explicit emergency
 * waiver.
 */
export async function runPostRolloutValidation(
  plan: PostRolloutValidationPlan,
  options: RunPostRolloutValidationOptions,
): Promise<PostRolloutValidationRecord> {
  assertValidPlan(plan);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const trigger: PostRolloutValidationTrigger = plan.trigger ?? 'manual';
  const context: PostRolloutValidationContext = {
    namespace: plan.namespace,
    release: plan.release,
    sourceCommit: plan.sourceCommit,
    imageReference: plan.imageReference,
    imageRevisionLabel: plan.imageRevisionLabel,
    helmRevision: plan.helmRevision,
  };

  const recordBase = {
    schemaVersion: POST_ROLLOUT_VALIDATION_SCHEMA_VERSION,
    namespace: plan.namespace,
    release: plan.release,
    sourceCommit: plan.sourceCommit,
    imageReference: plan.imageReference,
    imageRevisionLabel: plan.imageRevisionLabel,
    helmRevision: plan.helmRevision,
    trigger,
    startedAt,
  };

  // Documented emergency waiver: the gate is treated as healthy without running
  // the checks; every check is recorded as skipped and the justification kept.
  if (plan.emergencyWaiver !== undefined) {
    const checkedAt = now();
    const checks: PostRolloutCheckResult[] = POST_ROLLOUT_CHECK_IDS.map(id => ({
      id,
      title: CHECK_TITLES[id],
      required: false,
      verdict: 'skipped' as const,
      checkedAt,
      detail: 'skipped under approved emergency waiver',
    }));
    return {
      ...recordBase,
      completedAt: now(),
      overall: 'waived',
      healthy: true,
      recommendedAction: 'none',
      emergencyWaiver: { justification: plan.emergencyWaiver.justification.trim() },
      checks,
      failedChecks: [],
    };
  }

  const { runner } = options;
  const threshold = Math.max(1, Math.floor(options.toolValidationFailureThreshold ?? 1));
  const maxLogRecords = Math.max(0, Math.floor(options.maxLogRecords ?? DEFAULT_MAX_LOG_RECORDS));

  const liveSpecs: CheckSpec[] = [
    { id: 'rollout_status', run: ctx => runner.checkRolloutStatus(ctx) },
    { id: 'garden_health', run: ctx => runner.checkGardenHealth(ctx) },
    { id: 'model_route', run: ctx => runner.checkModelRoute(ctx) },
    { id: 'pgvector', run: ctx => runner.checkPgVector(ctx) },
    { id: 'redis_ping', run: ctx => runner.checkRedis(ctx) },
    { id: 'agent_readiness', run: ctx => runner.checkAgentReadiness(ctx) },
    { id: 'chat_turn_probe', run: ctx => runner.checkChatTurnProbe(ctx) },
  ];

  const liveChecks: PostRolloutCheckResult[] = [];
  for (const spec of liveSpecs) {
    liveChecks.push(await runOneCheck(spec, context, now()));
  }

  // Tool conformance (reuse x5rt.3). A failed fetch is inconclusive → fail.
  let conformanceCheck: PostRolloutCheckResult;
  try {
    const conformance = await runner.fetchToolConformance(context);
    conformanceCheck = classifyToolConformance(conformance, now());
  } catch (error) {
    conformanceCheck = {
      id: 'tool_conformance',
      title: CHECK_TITLES.tool_conformance,
      required: true,
      verdict: 'inconclusive',
      checkedAt: now(),
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // Log/diagnosis scan (reuse x5rt.2). A failed fetch is inconclusive → fail and
  // the record notes the log context is unavailable.
  let logScanCheck: PostRolloutCheckResult;
  let logContext: PostRolloutValidationLogContext;
  try {
    const snapshot = await runner.fetchDiagnostics(context);
    logScanCheck = classifyLogScan(snapshot, now(), {
      toolValidationFailureThreshold: threshold,
      maxLogRecords,
    });
    logContext = buildLogContext(snapshot, maxLogRecords);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logScanCheck = {
      id: 'log_scan',
      title: CHECK_TITLES.log_scan,
      required: true,
      verdict: 'inconclusive',
      checkedAt: now(),
      detail: reason,
    };
    logContext = { status: 'unavailable', reason };
  }

  const checks: PostRolloutCheckResult[] = [...liveChecks, conformanceCheck, logScanCheck];
  const failedChecks = checks
    .filter(check => check.required && check.verdict !== 'pass')
    .map(check => check.id);
  const healthy = failedChecks.length === 0;

  return {
    ...recordBase,
    completedAt: now(),
    overall: healthy ? 'passed' : 'failed',
    healthy,
    recommendedAction: healthy ? 'none' : 'rollback',
    checks,
    failedChecks,
    logContext,
  };
}

/** Compact, secret-free projection of the verdict for audit `details`. */
export function summarizePostRolloutValidationRecord(
  record: PostRolloutValidationRecord,
): Record<string, unknown> {
  return {
    namespace: record.namespace,
    release: record.release,
    sourceCommit: record.sourceCommit,
    imageReference: record.imageReference,
    helmRevision: record.helmRevision,
    trigger: record.trigger,
    overall: record.overall,
    healthy: record.healthy,
    recommendedAction: record.recommendedAction,
    failedChecks: record.failedChecks,
    checkVerdicts: record.checks.map(check => ({ id: check.id, verdict: check.verdict })),
    ...(record.emergencyWaiver ? { emergencyWaiver: true } : {}),
  };
}
