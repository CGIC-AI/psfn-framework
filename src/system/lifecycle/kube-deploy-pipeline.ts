import { createHash } from 'node:crypto';
import {
  isSensitiveValueKey,
  normalizeSensitiveKey,
} from '../../persistence/backups/kubernetes-helm-chart.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  isKubeDnsLabel,
  isKubeSourceRevision,
  isPinnedKubeImageReference,
  type KubeSelfManagementAction,
  type KubeSelfManagementExecutionResult,
  type KubeSelfManagementExecutor,
  type KubeSelfManagementRequest,
} from './kube-self-management.js';
import {
  runPostRolloutValidation,
  summarizePostRolloutValidationRecord,
  type PostRolloutValidationRecord,
  type PostRolloutValidationRunner,
} from './kube-post-rollout-validation.js';

/**
 * Guarded build -> test -> image -> deploy pipeline for the kube companion.
 *
 * This is the repo-owned generalization of the manual `ship-kube-update.sh`
 * flow into an auditable unit that runs strictly INSIDE the self-management
 * approval/audit boundary (x5rt.4) and credential separation (x5rt.10): the
 * agent may REQUEST a rebuild/deploy, an operator approves it, and only then
 * does the pipeline execute. No operator credential ever reaches this module —
 * all live-touching side effects are delegated to an injected
 * {@link DeployPipelineRunner} supplied by the operator-job composition.
 *
 * Ordering guarantee (fail-closed): the Helm upgrade is the ONLY stage that
 * mutates the running release. Every stage before it — preconditions, source
 * archive + checksum, quality gates, image build, image import, local k3d
 * validation — leaves live workloads unchanged, so any failure there yields a
 * record with `liveUntouched === true`. The `rebuild` action stops before the
 * Helm upgrade and produces a validated, imported (deployable) artifact; the
 * `deploy` action runs the full pipeline through the Helm upgrade.
 */

export const DEPLOY_PIPELINE_ACTIONS = ['rebuild', 'deploy'] as const;
export type DeployPipelineAction = typeof DEPLOY_PIPELINE_ACTIONS[number];

export type DeployPipelineStageId =
  | 'preconditions'
  | 'archive'
  | 'gate'
  | 'build'
  | 'import'
  | 'k3d_validation'
  | 'helm_upgrade'
  | 'post_rollout_validation';

export type DeployPipelineStageStatus = 'passed' | 'failed' | 'skipped' | 'not_run';

const BRANCH_PATTERN = /^(?!.*\.\.)(?!.*@\{)(?![/.])(?!.*[/.]$)[A-Za-z0-9._\-/]{1,255}$/;

export interface DeployPipelineGate {
  /** Stable identifier recorded in the pipeline record (e.g. `lint`). */
  id: string;
  /** Command the runner executes; recorded verbatim, never interpolated with secrets. */
  command: string;
}

/**
 * The quality gate that MUST pass before any live rollout unless an explicit,
 * justified emergency-recovery run is requested. `targeted-tests` is the
 * placeholder for the change-scoped test command; operator jobs override the
 * gate list to name the exact suites for the change under test.
 */
export const DEFAULT_DEPLOY_PIPELINE_GATES: readonly DeployPipelineGate[] = [
  { id: 'lint', command: 'npm run lint' },
  { id: 'build', command: 'npm run build' },
  { id: 'verify-helm-chart', command: 'npm run verify:helm-chart' },
  { id: 'targeted-tests', command: 'npm run test' },
];

export type DeployPipelineK3dValidationPlan =
  | { mode: 'run' }
  | { mode: 'skip'; reason: string };

export interface DeployPipelinePlan {
  action: DeployPipelineAction;
  namespace: string;
  release: string;
  /** Source branch the revision was selected from. Recorded for provenance. */
  sourceBranch: string;
  /** Exact 40-character source commit; also the image revision label. */
  sourceCommit: string;
  /** Image repository, e.g. `localhost/psfn-framework`. */
  imageRepository: string;
  /** Exact, non-floating image tag, e.g. `0.1.0-kube-<shortsha>`. */
  imageTag: string;
  /** Quality gates; defaults to {@link DEFAULT_DEPLOY_PIPELINE_GATES}. */
  gates?: readonly DeployPipelineGate[];
  /**
   * When present, this is a DOCUMENTED emergency-recovery run: the quality
   * gates are skipped and the justification is recorded. Fail-closed: an empty
   * justification is rejected.
   */
  emergencyRecovery?: { justification: string };
  /** Local k3d validation is either run or skipped with a recorded reason. */
  k3dValidation: DeployPipelineK3dValidationPlan;
}

export interface DeployPipelineRunnerContext {
  action: DeployPipelineAction;
  namespace: string;
  release: string;
  sourceBranch: string;
  sourceCommit: string;
  imageRepository: string;
  imageTag: string;
  imageRevisionLabel: string;
}

/**
 * Side-effecting seam. Every method touches the build host or the cluster; the
 * orchestrator supplies no credentials, so a real implementation carries the
 * operator-job's own transport. Injected so the whole pipeline is testable
 * without a cluster (fakes) per the x5rt.6 boundary; live coverage is x5rt.9.
 */
export interface DeployPipelineRunner {
  verifyPreconditions(
    context: DeployPipelineRunnerContext,
  ): Promise<{ workingTreeClean: boolean; backupVerified: boolean; detail?: string }>;
  archiveSource(context: DeployPipelineRunnerContext): Promise<{ sha256: string }>;
  runGate(
    gate: DeployPipelineGate,
    context: DeployPipelineRunnerContext,
  ): Promise<{ passed: boolean; detail?: string }>;
  buildImage(context: DeployPipelineRunnerContext): Promise<{ contractHash?: string }>;
  importImage(context: DeployPipelineRunnerContext): Promise<void>;
  validateOnK3d(
    context: DeployPipelineRunnerContext,
  ): Promise<{ passed: boolean; detail?: string }>;
  /** Returns the raw, possibly secret-bearing live release values. */
  captureLiveValues(context: DeployPipelineRunnerContext): Promise<Record<string, unknown>>;
  /** Performs the Helm upgrade; returns the new release revision. */
  helmUpgrade(
    context: DeployPipelineRunnerContext,
    liveValues: Record<string, unknown>,
  ): Promise<{ helmRevision: number }>;
}

export interface DeployPipelineGateResult {
  id: string;
  command: string;
  status: DeployPipelineStageStatus;
  detail?: string;
}

export interface DeployPipelineK3dValidationResult {
  status: 'passed' | 'failed' | 'skipped';
  skipReason?: string;
  detail?: string;
}

export interface DeployPipelineLiveValuesSummary {
  captured: boolean;
  /** Digest of the raw live values so operators can prove reuse without logging them. */
  sha256?: string;
  /** Keys whose values were redacted from the record (secret-bearing). */
  redactedKeys: string[];
}

export interface DeployPipelineStageRecord {
  id: DeployPipelineStageId;
  status: DeployPipelineStageStatus;
}

export interface DeployPipelineRecord {
  action: DeployPipelineAction;
  namespace: string;
  release: string;
  sourceBranch: string;
  sourceCommit: string;
  archiveSha256: string | null;
  imageRepository: string;
  imageTag: string;
  imageReference: string;
  imageRevisionLabel: string;
  contractHash: string | null;
  gate: {
    overall: 'passed' | 'failed' | 'skipped';
    emergencyRecovery: boolean;
    emergencyJustification?: string;
    results: DeployPipelineGateResult[];
  };
  k3dValidation: DeployPipelineK3dValidationResult;
  liveValues: DeployPipelineLiveValuesSummary;
  helmRevision: number | null;
  liveUntouched: boolean;
  /**
   * Post-rollout validation verdict (x5rt.7). Null when the gate did not run
   * (a `rebuild`, or a `deploy` with no post-rollout validator supplied). When
   * the gate runs and the companion is not healthy, the pipeline fails at the
   * `post_rollout_validation` stage with the verdict attached here so the
   * rollback surface (x5rt.8) can consume it.
   */
  postRolloutValidation: PostRolloutValidationRecord | null;
  stages: DeployPipelineStageRecord[];
  outcome: 'succeeded' | 'failed';
  failedStage?: DeployPipelineStageId;
  errorCode?: string;
}

export class DeployPipelineError extends Error {
  constructor(
    message: string,
    readonly record: DeployPipelineRecord,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DeployPipelineError';
  }
}

const STAGE_ORDER: readonly DeployPipelineStageId[] = [
  'preconditions',
  'archive',
  'gate',
  'build',
  'import',
  'k3d_validation',
  'helm_upgrade',
  'post_rollout_validation',
];

function isDeployPipelineAction(value: unknown): value is DeployPipelineAction {
  return typeof value === 'string' && DEPLOY_PIPELINE_ACTIONS.some(action => action === value);
}

function isSourceBranch(value: unknown): value is string {
  return typeof value === 'string' && BRANCH_PATTERN.test(value);
}

function assertValidPlan(plan: DeployPipelinePlan): void {
  if (!isDeployPipelineAction(plan.action)) {
    throw new Error('Kube deploy pipeline requires a rebuild or deploy action.');
  }
  if (!isKubeDnsLabel(plan.namespace) || !isKubeDnsLabel(plan.release)) {
    throw new Error('Kube deploy pipeline namespace and release must be DNS labels.');
  }
  if (!isSourceBranch(plan.sourceBranch)) {
    throw new Error('Kube deploy pipeline source branch is not a valid Git ref name.');
  }
  if (!isKubeSourceRevision(plan.sourceCommit)) {
    throw new Error('Kube deploy pipeline source commit must be an exact 40-character Git revision.');
  }
  if (!isPinnedKubeImageReference(`${plan.imageRepository}:${plan.imageTag}`)) {
    throw new Error('Kube deploy pipeline image reference must be an exact, non-floating pinned tag.');
  }
  if (plan.emergencyRecovery !== undefined
    && (typeof plan.emergencyRecovery.justification !== 'string'
      || plan.emergencyRecovery.justification.trim().length === 0)) {
    throw new Error('Kube deploy pipeline emergency recovery requires a non-empty justification.');
  }
  const gates = plan.gates ?? DEFAULT_DEPLOY_PIPELINE_GATES;
  if (plan.emergencyRecovery === undefined && gates.length === 0) {
    throw new Error('Kube deploy pipeline requires at least one quality gate outside emergency recovery.');
  }
  const seenGateIds = new Set<string>();
  for (const gate of gates) {
    if (typeof gate.id !== 'string' || gate.id.trim().length === 0
      || typeof gate.command !== 'string' || gate.command.trim().length === 0) {
      throw new Error('Kube deploy pipeline gate entries require a non-empty id and command.');
    }
    if (seenGateIds.has(gate.id)) {
      throw new Error(`Kube deploy pipeline gate ids must be unique: ${gate.id}`);
    }
    seenGateIds.add(gate.id);
  }
  if (plan.k3dValidation.mode === 'skip'
    && (typeof plan.k3dValidation.reason !== 'string'
      || plan.k3dValidation.reason.trim().length === 0)) {
    throw new Error('Kube deploy pipeline k3d validation skip requires a recorded reason.');
  }
}

/**
 * Recursively redacts secret-bearing values (reusing the recovery-chart secret
 * key taxonomy) so a captured live-values object can be summarized in the
 * record and logs without leaking credentials.
 */
export function redactLiveHelmValues(
  value: unknown,
  parentKeyIsSecret = false,
): { redacted: unknown; redactedKeys: string[] } {
  const redactedKeys: string[] = [];
  const walk = (node: unknown, keyIsSecret: boolean, path: string): unknown => {
    if (keyIsSecret) {
      if (path) redactedKeys.push(path);
      return '[redacted]';
    }
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, false, `${path}[${index}]`));
    }
    if (isRecord(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(node)) {
        const childPath = path ? `${path}.${key}` : key;
        out[key] = walk(nested, isSensitiveValueKey(normalizeSensitiveKey(key)), childPath);
      }
      return out;
    }
    return node;
  };
  const redacted = walk(value, parentKeyIsSecret, '');
  redactedKeys.sort((a, b) => a.localeCompare(b));
  return { redacted, redactedKeys };
}

function hashLiveValues(value: Record<string, unknown>): string {
  return createHash('sha256')
    .update('kube-deploy-pipeline-live-values-v1\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

function initialRecord(plan: DeployPipelinePlan): DeployPipelineRecord {
  const emergencyRecovery = plan.emergencyRecovery !== undefined;
  const gates = plan.gates ?? DEFAULT_DEPLOY_PIPELINE_GATES;
  return {
    action: plan.action,
    namespace: plan.namespace,
    release: plan.release,
    sourceBranch: plan.sourceBranch,
    sourceCommit: plan.sourceCommit,
    archiveSha256: null,
    imageRepository: plan.imageRepository,
    imageTag: plan.imageTag,
    imageReference: `${plan.imageRepository}:${plan.imageTag}`,
    imageRevisionLabel: plan.sourceCommit,
    contractHash: null,
    gate: {
      overall: emergencyRecovery ? 'skipped' : 'passed',
      emergencyRecovery,
      ...(emergencyRecovery
        ? { emergencyJustification: plan.emergencyRecovery?.justification.trim() }
        : {}),
      results: gates.map(gate => ({
        id: gate.id,
        command: gate.command,
        status: 'not_run' as DeployPipelineStageStatus,
      })),
    },
    k3dValidation: plan.k3dValidation.mode === 'skip'
      ? { status: 'skipped', skipReason: plan.k3dValidation.reason.trim() }
      : { status: 'skipped' },
    liveValues: { captured: false, redactedKeys: [] },
    helmRevision: null,
    liveUntouched: true,
    postRolloutValidation: null,
    stages: STAGE_ORDER.map(id => ({ id, status: 'not_run' as DeployPipelineStageStatus })),
    outcome: 'failed',
    errorCode: 'incomplete',
  };
}

function setStage(
  record: DeployPipelineRecord,
  id: DeployPipelineStageId,
  status: DeployPipelineStageStatus,
): void {
  const stage = record.stages.find(entry => entry.id === id);
  if (stage) stage.status = status;
}

function fail(
  record: DeployPipelineRecord,
  stage: DeployPipelineStageId,
  errorCode: string,
  message: string,
  cause?: unknown,
): never {
  setStage(record, stage, 'failed');
  record.outcome = 'failed';
  record.failedStage = stage;
  record.errorCode = errorCode;
  throw new DeployPipelineError(message, record, cause !== undefined ? { cause } : undefined);
}

/**
 * Encodes the proven k3s import trap: `k3s ctr images import` names the image
 * `docker.io/library/<name>:<tag>`, so it MUST be retagged to
 * `localhost/<name>:<tag>` or the Deployments (which pull `localhost/...`) will
 * not find it. Given the pinned `localhost/...` reference the runtime targets,
 * this returns the import-time source tag and the required destination tag.
 */
export function deriveLocalImportRetag(
  reference: string,
): { from: string; to: string } {
  if (!isPinnedKubeImageReference(reference)) {
    throw new Error('Kube deploy pipeline image retag requires a pinned image reference.');
  }
  const localhostPrefix = 'localhost/';
  if (!reference.startsWith(localhostPrefix)) {
    throw new Error('Kube deploy pipeline expects a localhost/-scoped runtime image reference.');
  }
  const bareName = reference.slice(localhostPrefix.length);
  const lastSlash = bareName.lastIndexOf('/');
  const lastColon = bareName.lastIndexOf(':');
  if (!(lastColon > lastSlash)) {
    throw new Error('Kube deploy pipeline image retag requires an explicit tag.');
  }
  return {
    from: `docker.io/library/${bareName}`,
    to: reference,
  };
}

/**
 * Post-rollout validation wiring (x5rt.7). Opt-in and supplied only by the
 * operator-job composition (its own transport, no agent credentials). When
 * present on a `deploy`, the gate runs after `helm_upgrade` against the live-
 * rolled companion; an unhealthy verdict fails the pipeline at the
 * `post_rollout_validation` stage with the verdict attached to the record. When
 * absent, the stage stays `not_run` (the pipeline mechanics are honest about not
 * having validated), and the composition layer is responsible for the health
 * decision. `rebuild` never reaches this stage.
 */
export interface DeployPipelinePostRolloutValidation {
  runner: PostRolloutValidationRunner;
  /**
   * Documented emergency waiver forwarded to the gate: the verdict is recorded
   * as healthy-by-waiver without running checks. Fail-closed on an empty
   * justification (rejected by the gate).
   */
  emergencyWaiver?: { justification: string };
  /** Post-rollout tool-validation-failure count that fails the log scan (default 1). */
  toolValidationFailureThreshold?: number;
  /**
   * Persist the verdict so x5rt.8 can read it out-of-band. Invoked on BOTH the
   * healthy and unhealthy paths before the pipeline resolves/throws.
   */
  persist?: (record: PostRolloutValidationRecord) => void;
  now?: () => number;
}

export interface RunKubeDeployPipelineOptions {
  runner: DeployPipelineRunner;
  postRolloutValidation?: DeployPipelinePostRolloutValidation;
}

/**
 * Executes the guarded pipeline. Resolves with the record on success and
 * rejects with a {@link DeployPipelineError} (carrying the partial record) on
 * any failure — fail-closed. Live workloads are untouched until the
 * `helm_upgrade` stage; `rebuild` never reaches it.
 */
export async function runKubeDeployPipeline(
  plan: DeployPipelinePlan,
  options: RunKubeDeployPipelineOptions,
): Promise<DeployPipelineRecord> {
  assertValidPlan(plan);
  const record = initialRecord(plan);
  const context: DeployPipelineRunnerContext = {
    action: plan.action,
    namespace: plan.namespace,
    release: plan.release,
    sourceBranch: plan.sourceBranch,
    sourceCommit: plan.sourceCommit,
    imageRepository: plan.imageRepository,
    imageTag: plan.imageTag,
    imageRevisionLabel: plan.sourceCommit,
  };
  const gates = plan.gates ?? DEFAULT_DEPLOY_PIPELINE_GATES;
  const { runner } = options;

  // 1. Preconditions: only committed state ships; a verified backup must exist
  // before any companion-data mutation.
  let preconditions: { workingTreeClean: boolean; backupVerified: boolean; detail?: string };
  try {
    preconditions = await runner.verifyPreconditions(context);
  } catch (error) {
    fail(record, 'preconditions', 'preconditions_failed',
      'Kube deploy pipeline preconditions check failed.', error);
  }
  if (!preconditions.workingTreeClean) {
    fail(record, 'preconditions', 'working_tree_dirty',
      'Kube deploy pipeline refuses to ship a dirty working tree.');
  }
  if (!preconditions.backupVerified) {
    fail(record, 'preconditions', 'backup_unverified',
      'Kube deploy pipeline requires a verified backup before rollout.');
  }
  setStage(record, 'preconditions', 'passed');

  // 2. Source archive + checksum.
  try {
    const archive = await runner.archiveSource(context);
    if (!/^[0-9a-f]{64}$/.test(archive.sha256)) {
      fail(record, 'archive', 'archive_checksum_invalid',
        'Kube deploy pipeline produced an invalid source archive checksum.');
    }
    record.archiveSha256 = archive.sha256;
    setStage(record, 'archive', 'passed');
  } catch (error) {
    if (error instanceof DeployPipelineError) throw error;
    fail(record, 'archive', 'archive_failed',
      'Kube deploy pipeline source archive failed.', error);
  }

  // 3. Quality gate (skipped only in documented emergency recovery).
  if (plan.emergencyRecovery !== undefined) {
    for (const result of record.gate.results) result.status = 'skipped';
    record.gate.overall = 'skipped';
    setStage(record, 'gate', 'skipped');
  } else {
    for (const gate of gates) {
      const entry = record.gate.results.find(result => result.id === gate.id);
      let outcome: { passed: boolean; detail?: string };
      try {
        outcome = await runner.runGate(gate, context);
      } catch (error) {
        if (entry) {
          entry.status = 'failed';
          entry.detail = error instanceof Error ? error.message : String(error);
        }
        record.gate.overall = 'failed';
        fail(record, 'gate', 'gate_failed',
          `Kube deploy pipeline gate ${gate.id} threw.`, error);
      }
      if (entry) {
        entry.status = outcome.passed ? 'passed' : 'failed';
        if (outcome.detail !== undefined) entry.detail = outcome.detail;
      }
      if (!outcome.passed) {
        record.gate.overall = 'failed';
        fail(record, 'gate', 'gate_failed',
          `Kube deploy pipeline gate ${gate.id} failed.`);
      }
    }
    record.gate.overall = 'passed';
    setStage(record, 'gate', 'passed');
  }

  // 4. Image build with the exact tag and org.opencontainers.image.revision label.
  try {
    const build = await runner.buildImage(context);
    record.contractHash = build.contractHash ?? null;
    setStage(record, 'build', 'passed');
  } catch (error) {
    fail(record, 'build', 'build_failed',
      'Kube deploy pipeline image build failed.', error);
  }

  // 5. Import the image into the runtime (docker.io/library -> localhost retag).
  // Importing does not change running pods; live stays untouched.
  try {
    await runner.importImage(context);
    setStage(record, 'import', 'passed');
  } catch (error) {
    fail(record, 'import', 'import_failed',
      'Kube deploy pipeline image import failed.', error);
  }

  // 6. Local k3d validation (run or recorded skip).
  if (plan.k3dValidation.mode === 'run') {
    let k3dOutcome: { passed: boolean; detail?: string };
    try {
      k3dOutcome = await runner.validateOnK3d(context);
    } catch (error) {
      record.k3dValidation = {
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
      fail(record, 'k3d_validation', 'k3d_validation_failed',
        'Kube deploy pipeline k3d validation threw.', error);
    }
    record.k3dValidation = {
      status: k3dOutcome.passed ? 'passed' : 'failed',
      ...(k3dOutcome.detail !== undefined ? { detail: k3dOutcome.detail } : {}),
    };
    if (!k3dOutcome.passed) {
      fail(record, 'k3d_validation', 'k3d_validation_failed',
        'Kube deploy pipeline k3d validation failed.');
    }
    setStage(record, 'k3d_validation', 'passed');
  } else {
    setStage(record, 'k3d_validation', 'skipped');
  }

  // `rebuild` produces a validated, imported artifact and stops before rollout.
  if (plan.action === 'rebuild') {
    setStage(record, 'helm_upgrade', 'not_run');
    record.liveUntouched = true;
    record.outcome = 'succeeded';
    delete record.errorCode;
    return record;
  }

  // 7. Helm upgrade — the single live-mutating stage. Capture live values,
  // record only a redacted summary, and pass the raw values through so a
  // changed chart never loses live configuration (never --reuse-values).
  let liveValues: Record<string, unknown>;
  try {
    liveValues = await runner.captureLiveValues(context);
  } catch (error) {
    fail(record, 'helm_upgrade', 'live_values_capture_failed',
      'Kube deploy pipeline failed to capture live Helm values.', error);
  }
  const { redactedKeys } = redactLiveHelmValues(liveValues);
  record.liveValues = {
    captured: true,
    sha256: hashLiveValues(liveValues),
    redactedKeys,
  };

  record.liveUntouched = false;
  try {
    const upgrade = await runner.helmUpgrade(context, liveValues);
    if (!Number.isSafeInteger(upgrade.helmRevision) || upgrade.helmRevision <= 0) {
      fail(record, 'helm_upgrade', 'helm_revision_invalid',
        'Kube deploy pipeline Helm upgrade returned an invalid release revision.');
    }
    record.helmRevision = upgrade.helmRevision;
    setStage(record, 'helm_upgrade', 'passed');
  } catch (error) {
    if (error instanceof DeployPipelineError) throw error;
    fail(record, 'helm_upgrade', 'helm_upgrade_failed',
      'Kube deploy pipeline Helm upgrade failed.', error);
  }

  // 8. Post-rollout validation (x5rt.7) — runs AFTER the live rollout against the
  // live-rolled companion. Opt-in; when no validator is supplied the stage stays
  // `not_run` and the composition layer owns the health decision. Fail-closed: an
  // unhealthy verdict fails the pipeline with the verdict attached so the sibling
  // rollback surface (x5rt.8) can consume it. The verdict is persisted on BOTH
  // paths before this function resolves or throws.
  if (options.postRolloutValidation) {
    const validation = options.postRolloutValidation;
    let verdict: PostRolloutValidationRecord;
    try {
      verdict = await runPostRolloutValidation(
        {
          namespace: plan.namespace,
          release: plan.release,
          sourceCommit: plan.sourceCommit,
          imageReference: record.imageReference,
          imageRevisionLabel: record.imageRevisionLabel,
          helmRevision: upgradeRevision(record),
          trigger: 'deploy_pipeline',
          ...(validation.emergencyWaiver ? { emergencyWaiver: validation.emergencyWaiver } : {}),
        },
        {
          runner: validation.runner,
          ...(validation.toolValidationFailureThreshold !== undefined
            ? { toolValidationFailureThreshold: validation.toolValidationFailureThreshold }
            : {}),
          ...(validation.now ? { now: validation.now } : {}),
        },
      );
    } catch (error) {
      fail(record, 'post_rollout_validation', 'post_rollout_validation_errored',
        'Kube deploy pipeline post-rollout validation could not run.', error);
    }
    record.postRolloutValidation = verdict;
    if (validation.persist) validation.persist(verdict);
    if (!verdict.healthy) {
      fail(record, 'post_rollout_validation', 'post_rollout_validation_failed',
        'Kube deploy pipeline post-rollout validation reported an unhealthy companion.');
    }
    setStage(record, 'post_rollout_validation', 'passed');
  }

  record.outcome = 'succeeded';
  delete record.errorCode;
  return record;
}

/** The recorded Helm revision after a successful upgrade; guaranteed positive here. */
function upgradeRevision(record: DeployPipelineRecord): number {
  if (record.helmRevision === null) {
    throw new Error('Kube deploy pipeline post-rollout validation ran without a Helm revision.');
  }
  return record.helmRevision;
}

/** Sanitized, secret-free projection of the record for audit `details`. */
export function summarizeDeployPipelineRecord(
  record: DeployPipelineRecord,
): Record<string, unknown> {
  return {
    action: record.action,
    namespace: record.namespace,
    release: record.release,
    sourceBranch: record.sourceBranch,
    sourceCommit: record.sourceCommit,
    archiveSha256: record.archiveSha256,
    imageReference: record.imageReference,
    imageRevisionLabel: record.imageRevisionLabel,
    contractHash: record.contractHash,
    gateOverall: record.gate.overall,
    emergencyRecovery: record.gate.emergencyRecovery,
    k3dValidation: record.k3dValidation.status,
    liveValuesCaptured: record.liveValues.captured,
    liveValuesSha256: record.liveValues.sha256 ?? null,
    helmRevision: record.helmRevision,
    liveUntouched: record.liveUntouched,
    ...(record.postRolloutValidation
      ? { postRolloutValidation: summarizePostRolloutValidationRecord(record.postRolloutValidation) }
      : {}),
    outcome: record.outcome,
    ...(record.failedStage ? { failedStage: record.failedStage } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  };
}

export interface KubeDeployPipelineExecutorOptions {
  runner: DeployPipelineRunner;
  /**
   * Resolves the source/image/validation plan details that the approval
   * request does not carry (branch, gate list, k3d mode). Supplied by the
   * operator-job composition, which owns the build host context.
   */
  resolvePlan(request: KubeSelfManagementRequest & { action: DeployPipelineAction }): Omit<
    DeployPipelinePlan,
    'action' | 'namespace' | 'release'
  >;
  /**
   * Post-rollout validation gate (x5rt.7). Supplied by the operator-job
   * composition so a `deploy` is validated against the live-rolled companion and
   * an unhealthy verdict surfaces as a `failed` validation result (and a throw)
   * the controller audits and x5rt.8 acts on. Never supplied by the agent path.
   */
  postRolloutValidation?: DeployPipelinePostRolloutValidation;
}

/**
 * Adapts the pipeline into a {@link KubeSelfManagementExecutor} so `rebuild`
 * and `deploy` become available behind the existing approval/audit boundary.
 * A gate/validation/rollout failure throws — the controller then audits the
 * failure and, because the throw happens before (or at) the mutation boundary,
 * the record proves whether live was touched.
 */
export function createKubeDeployPipelineExecutor(
  options: KubeDeployPipelineExecutorOptions,
): KubeSelfManagementExecutor {
  return {
    supports: (action: KubeSelfManagementAction): boolean => isDeployPipelineAction(action),
    execute: async (
      request: KubeSelfManagementRequest,
    ): Promise<KubeSelfManagementExecutionResult> => {
      if (!isDeployPipelineAction(request.action)) {
        throw new Error('Kube deploy pipeline executor received an unsupported action.');
      }
      const details = options.resolvePlan({ ...request, action: request.action });
      const plan: DeployPipelinePlan = {
        action: request.action,
        namespace: request.namespace,
        release: request.release,
        ...details,
      };
      const record = await runKubeDeployPipeline(plan, {
        runner: options.runner,
        ...(options.postRolloutValidation
          ? { postRolloutValidation: options.postRolloutValidation }
          : {}),
      });
      // A post-rollout gate that ran and passed is the strongest health signal;
      // otherwise fall back to the pre-rollout quality-gate outcome. (An unhealthy
      // verdict throws inside the pipeline, so it never reaches this success path.)
      const validationResult: KubeSelfManagementExecutionResult['validationResult'] =
        record.postRolloutValidation?.healthy === true ? 'passed'
          : record.gate.overall === 'passed' ? 'passed'
            : record.gate.overall === 'failed' ? 'failed'
              : 'not_run';
      return {
        validationResult,
        rollbackStatus: 'not_requested',
        details: summarizeDeployPipelineRecord(record),
      };
    },
  };
}

/**
 * Combines executors so a single controller can dispatch read-only diagnostics
 * (existing) alongside the deploy pipeline. First executor that `supports` an
 * action wins; ambiguous overlap fails closed.
 */
export function combineKubeSelfManagementExecutors(
  executors: readonly KubeSelfManagementExecutor[],
): KubeSelfManagementExecutor {
  if (executors.length === 0) {
    throw new Error('At least one kube self-management executor is required.');
  }
  const supportersFor = (action: KubeSelfManagementAction): KubeSelfManagementExecutor[] =>
    executors.filter(executor => executor.supports(action));
  return {
    supports: (action: KubeSelfManagementAction): boolean => supportersFor(action).length === 1,
    execute: async (
      request: KubeSelfManagementRequest,
    ): Promise<KubeSelfManagementExecutionResult> => {
      const supporters = supportersFor(request.action);
      if (supporters.length !== 1) {
        throw new Error(
          `Kube self-management action ${request.action} has no unique executor.`,
        );
      }
      return supporters[0].execute(request);
    },
  };
}
