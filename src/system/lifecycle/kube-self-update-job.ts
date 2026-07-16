// ── Kube self-update operator-job composition (x5rt.9) ──
//
// The load-bearing wiring that turns the x5rt.6/.7/.8 LIBRARY + SEAMS into a
// single, live, credential-bearing operator job: build/test/deploy pipeline ->
// post-rollout validation (with the verdict PERSISTED) -> automatic Helm
// rollback on a bound, unhealthy verdict. Without this composition the epic
// merges as fully-tested-but-never-invoked dead code — the three seams
// (DeployPipelineRunner, the post-rollout persist callback, executeAutoRollback)
// have no production caller until this function connects them.
//
// This module is pure wiring over injected ports so it is unit-testable with
// fakes (the mandatory gate); the live docker/helm/kubectl transports live in
// the operator entrypoint (src/app/operator/…) and never reach the agent
// process, preserving the x5rt.10 credential separation.
//
// Cross-bead contracts honoured here (from the x5rt.8 dual review):
//
//   1. PERSIST IS REQUIRED WHEN AUTO-ROLLBACK IS ENABLED. Auto-rollback reads
//      the persisted verdict out-of-band and BINDS it to the current rollout;
//      if the pipeline validated but never persisted, the safety net would read
//      a stale/absent verdict, see a binding mismatch, and silently NOT roll
//      back an actually-broken deploy. So when auto-rollback is enabled this job
//      ALWAYS wires the pipeline's post-rollout persist callback (and refuses to
//      run without a validation runner) — the verdict is written on both the
//      healthy and unhealthy paths before executeAutoRollback consults it.
//
//   2. THE CALLER SERIALIZES executeAutoRollback. The rollback ledger's
//      read-modify-write has no lock (Pi obs 7); two overlapping deploy jobs
//      could both read a pre-rollback ledger and both roll back. This job funnels
//      every executeAutoRollback call through a process-wide single-flight guard
//      so the act-once ledger is always read after the prior write commits.
//
//   3. AUTO-ROLLBACK ONLY AFTER THE LIVE MUTATION. A deploy that fails BEFORE
//      the Helm upgrade (dirty tree, gate failure, build/import/k3d failure) left
//      live untouched — there is nothing to roll back and the stale verdict must
//      not be misread. Auto-rollback is evaluated only once the rollout actually
//      reached (and recorded) a live Helm revision.

import {
  DeployPipelineError,
  runKubeDeployPipeline,
  type DeployPipelinePlan,
  type DeployPipelinePostRolloutValidation,
  type DeployPipelineRecord,
  type DeployPipelineRunner,
} from './kube-deploy-pipeline.js';
import type {
  PostRolloutValidationRecord,
  PostRolloutValidationRunner,
} from './kube-post-rollout-validation.js';
import { writePostRolloutValidationVerdict } from './kube-post-rollout-validation-store.js';
import {
  executeAutoRollback,
  type AutoRollbackAuditEvent,
  type AutoRollbackOutcome,
  type ExecuteAutoRollbackOptions,
  type KubeRollbackTargetResolution,
} from './kube-auto-rollback.js';
import type { KubeHelmRollbackApiPort } from './kube-helm-rollback.js';
import type { LifecycleKubernetesSettings } from '../config/runtime-config-contracts.js';

/** The auto-rollback disposition for a self-update job. */
export type KubeSelfUpdateAutoRollbackDisposition =
  | AutoRollbackOutcome
  | { status: 'skipped'; detail: string };

export interface KubeSelfUpdateJobResult {
  /** The deploy pipeline record (from success OR the failed record on a pipeline throw). */
  pipeline: DeployPipelineRecord;
  /** What the auto-rollback safety net did (or why it was skipped). */
  autoRollback: KubeSelfUpdateAutoRollbackDisposition;
}

export interface KubeSelfUpdateAutoRollbackConfig {
  /** Defaults to true; set false to run a deploy job with no automatic safety net. */
  enabled?: boolean;
  /** Operator-job Helm rollback transport (release-management credentials). */
  api: KubeHelmRollbackApiPort;
  /** Resolves the strictly-earlier known-good revision from `helm history`. */
  resolveRollbackTarget: (failedRevision: number) => Promise<KubeRollbackTargetResolution>;
}

export interface KubeSelfUpdateJobOptions {
  /** The build/test/deploy plan (action must be `deploy` for a live rollout). */
  plan: DeployPipelinePlan;
  /** System-owned data dir where the verdict + rollback ledger live. */
  systemDataDir: string;
  /** Exact Helm fullname prefix for the three managed Deployments. */
  resourcePrefix: string;
  /** Canonical settings.json operational policy for this live job. */
  lifecycleKubernetes: LifecycleKubernetesSettings;
  /** Live build/import/helm transport (operator-job credentials). */
  deployRunner: DeployPipelineRunner;
  /**
   * Live post-rollout validation transport. REQUIRED when auto-rollback is
   * enabled (a verdict must be produced and persisted for the rollout). Optional
   * only for a deploy-only job with auto-rollback disabled.
   */
  postRolloutValidationRunner?: PostRolloutValidationRunner;
  /** Forwarded to the post-rollout gate's log scan (default 1: any failure fails). */
  toolValidationFailureThreshold?: number;
  /** Documented emergency waiver forwarded to the post-rollout gate. */
  emergencyWaiver?: { justification: string };
  /** Automatic Helm rollback safety net; provide to enable it (enabled by default when present). */
  autoRollback?: KubeSelfUpdateAutoRollbackConfig;
  /** Emitted for every terminal auto-rollback decision (audit trail). */
  audit?: (event: AutoRollbackAuditEvent) => Promise<void>;
  /**
   * Persist hook for the post-rollout verdict. Defaults to the durable store
   * writer; injected in tests. When auto-rollback is enabled this is ALWAYS
   * wired into the pipeline so the safety net has a verdict to bind.
   */
  persistVerdict?: (systemDataDir: string, record: PostRolloutValidationRecord) => void;
  /**
   * Serialization guard around executeAutoRollback's ledger read-modify-write.
   * Defaults to a process-wide single-flight so overlapping jobs never race the
   * act-once ledger. Injected in tests to observe serialization.
   */
  runExclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * The auto-rollback executor. Defaults to the real executeAutoRollback;
   * injected in tests to assert the wiring drives it with the bound rollout.
   */
  executeAutoRollbackFn?: (options: ExecuteAutoRollbackOptions) => Promise<AutoRollbackOutcome>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// Process-wide single-flight: the deploy job is the only writer of the rollback
// ledger, and every ledger read-modify-write must observe the prior write. A
// module-level chain serializes all auto-rollback evaluations in this process
// (the operator job runs one process; cross-process serialization is out of
// scope — one operator job at a time is the operational contract).
let autoRollbackChain: Promise<unknown> = Promise.resolve();
function defaultAutoRollbackSerializer<T>(fn: () => Promise<T>): Promise<T> {
  const run = autoRollbackChain.then(fn, fn);
  // Swallow the settled result for the chain anchor so one rejection does not
  // poison every subsequent serialized call; the real result/rejection still
  // propagates through `run` to this caller.
  autoRollbackChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Run the composed self-update operator job: deploy pipeline (with the verdict
 * persisted) followed by the serialized automatic rollback safety net. Resolves
 * with the pipeline record and the auto-rollback disposition. Fail-closed: a
 * pipeline failure at or before the live Helm upgrade yields a record with the
 * failure and NO rollback (nothing was mutated); a bound, unhealthy verdict for
 * a live rollout triggers exactly one rollback via the act-once ledger.
 */
export async function runKubeSelfUpdateJob(
  options: KubeSelfUpdateJobOptions,
): Promise<KubeSelfUpdateJobResult> {
  const autoRollbackEnabled =
    options.autoRollback !== undefined && options.autoRollback.enabled !== false;

  // Contract 1: persist is required when auto-rollback is enabled. We can only
  // guarantee a persisted, bound verdict if a validation runner produced one.
  if (autoRollbackEnabled && !options.postRolloutValidationRunner) {
    throw new Error(
      'Kube self-update job: automatic rollback requires a post-rollout validation runner '
      + 'so a verdict is produced and persisted for the rollout to bind against.',
    );
  }

  const persistVerdict = options.persistVerdict
    ?? ((systemDataDir, record) => writePostRolloutValidationVerdict(
      systemDataDir,
      record,
      options.lifecycleKubernetes.postRolloutValidationHistoryLimit,
    ));

  let postRolloutValidation: DeployPipelinePostRolloutValidation | undefined;
  if (options.postRolloutValidationRunner) {
    postRolloutValidation = {
      runner: options.postRolloutValidationRunner,
      maxLogRecords: options.lifecycleKubernetes.postRolloutMaxLogRecords,
      // Always wire persist: the whole safety net depends on the verdict being
      // durably written (on both healthy and unhealthy paths) before
      // executeAutoRollback reads it.
      persist: (record) => persistVerdict(options.systemDataDir, record),
      ...(options.emergencyWaiver ? { emergencyWaiver: options.emergencyWaiver } : {}),
      ...(options.toolValidationFailureThreshold !== undefined
        ? { toolValidationFailureThreshold: options.toolValidationFailureThreshold }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    };
  }

  // Run the pipeline. An unhealthy post-rollout verdict fails the pipeline at the
  // post_rollout_validation stage AFTER persisting the verdict, throwing a
  // DeployPipelineError whose record we consume. Any other pipeline failure also
  // arrives as a DeployPipelineError with the partial record.
  let pipeline: DeployPipelineRecord;
  try {
    pipeline = await runKubeDeployPipeline(options.plan, {
      runner: options.deployRunner,
      ...(postRolloutValidation ? { postRolloutValidation } : {}),
    });
  } catch (error) {
    if (error instanceof DeployPipelineError) {
      pipeline = error.record;
    } else {
      // A non-pipeline throw is an unexpected fault — fail closed, do not attempt
      // a rollback on an unknown state.
      throw error;
    }
  }

  if (!autoRollbackEnabled) {
    return {
      pipeline,
      autoRollback: { status: 'skipped', detail: 'automatic rollback not enabled for this job' },
    };
  }

  // Contract 3: only evaluate rollback once the rollout actually reached the live
  // Helm upgrade. `rebuild`, or a `deploy` that failed before helm_upgrade, left
  // live untouched — there is nothing to roll back and the persisted verdict (if
  // any) does not bind to a live revision.
  if (pipeline.liveUntouched || pipeline.helmRevision === null) {
    return {
      pipeline,
      autoRollback: {
        status: 'skipped',
        detail: 'deploy did not reach the live Helm upgrade; live untouched, nothing to roll back',
      },
    };
  }

  const autoRollback = options.autoRollback!;
  const runExclusive = options.runExclusive ?? defaultAutoRollbackSerializer;
  const executeAutoRollbackFn = options.executeAutoRollbackFn ?? executeAutoRollback;

  const outcome = await runExclusive(() => executeAutoRollbackFn({
    namespace: pipeline.namespace,
    release: pipeline.release,
    resourcePrefix: options.resourcePrefix,
    systemDataDir: options.systemDataDir,
    currentRollout: {
      release: pipeline.release,
      helmRevision: pipeline.helmRevision as number,
      sourceCommit: pipeline.sourceCommit,
    },
    api: autoRollback.api,
    resolveRollbackTarget: autoRollback.resolveRollbackTarget,
    ...(options.audit ? { audit: options.audit } : {}),
    waitTimeoutMs: options.lifecycleKubernetes.rollbackWaitTimeoutMs,
    pollIntervalMs: options.lifecycleKubernetes.rollbackPollIntervalMs,
    rollbackHistoryLimit: options.lifecycleKubernetes.rollbackHistoryLimit,
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  }));

  return { pipeline, autoRollback: outcome };
}
