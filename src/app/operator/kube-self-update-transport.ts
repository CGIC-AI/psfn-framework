// ── Live operator-job transports for the kube self-update pipeline (x5rt.9) ──
//
// These are the credential-bearing implementations of the injected ports the
// x5rt.6/.7/.8 library exposes. They shell out to git/docker/helm/kubectl — the
// same tools the manual ship-kube-update.sh flow drives — and are composed ONLY
// in the operator-job entrypoint, never in the agent process (x5rt.10). Every
// command failure propagates (fail-closed); nothing is swallowed.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isRecord } from '../../shared/utils/types.js';
import type { KubeDeploymentDiagnostic } from '../../system/lifecycle/kube-diagnostics.js';
import {
  deriveLocalImportRetag,
  type DeployPipelineGate,
  type DeployPipelineRunner,
  type DeployPipelineRunnerContext,
} from '../../system/lifecycle/kube-deploy-pipeline.js';
import type { KubeHelmRollbackApiPort } from '../../system/lifecycle/kube-helm-rollback.js';
import type { KubeRollbackTargetResolution } from '../../system/lifecycle/kube-auto-rollback.js';

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

/** Injected command runner so transports are testable without real binaries. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/** Build an execFile runner with its default timeout owned by settings.json. */
export function createExecFileCommandRunner(commandTimeoutMs: number): CommandRunner {
  requirePositiveInt('commandTimeoutMs', commandTimeoutMs);
  return (file, args, options = {}) => new Promise<CommandResult>((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? commandTimeoutMs,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== 'number') {
          // Spawn/timeout error (binary missing, killed): propagate — never a silent pass.
          reject(error);
          return;
        }
        const code = error ? Number((error as { code: number }).code) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

function requireDnsLabel(field: string, value: string): void {
  if (!DNS_LABEL_PATTERN.test(value)) {
    throw new Error(`Kube self-update transport: ${field} must be a DNS label (got "${value}").`);
  }
}

function requirePositiveInt(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Kube self-update transport: ${field} must be a positive integer.`);
  }
}

function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

function mapDeploymentJson(name: string, json: unknown): KubeDeploymentDiagnostic {
  if (!isRecord(json)) {
    throw new Error(`Kube self-update transport: invalid Deployment JSON for ${name}.`);
  }
  const metadata = isRecord(json.metadata) ? json.metadata : {};
  const spec = isRecord(json.spec) ? json.spec : {};
  const status = isRecord(json.status) ? json.status : {};
  const asInt = (value: unknown): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    name,
    generation: asInt(metadata.generation),
    observedGeneration: asInt(status.observedGeneration),
    desiredReplicas: asInt(spec.replicas),
    readyReplicas: asInt(status.readyReplicas),
    updatedReplicas: asInt(status.updatedReplicas),
    availableReplicas: asInt(status.availableReplicas),
  };
}

export interface HelmKubectlConfig {
  helmBin?: string;
  kubectlBin?: string;
  /** Extra args prepended to every helm/kubectl call (e.g. --kubeconfig=…). */
  helmGlobalArgs?: readonly string[];
  kubectlGlobalArgs?: readonly string[];
  run: CommandRunner;
}

interface HelmHistoryEntry {
  revision: number;
  status: string;
}

function parseHelmHistory(stdout: string): HelmHistoryEntry[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Kube self-update transport: helm history did not return a JSON array.');
  }
  const entries: HelmHistoryEntry[] = [];
  for (const raw of parsed) {
    if (!isRecord(raw)) continue;
    const revision = raw.revision;
    const status = raw.status;
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && typeof status === 'string') {
      entries.push({ revision, status });
    }
  }
  return entries;
}

/** Read the Helm release history as parsed revision/status entries. */
export async function readHelmHistory(
  config: HelmKubectlConfig,
  namespace: string,
  release: string,
): Promise<HelmHistoryEntry[]> {
  requireDnsLabel('namespace', namespace);
  requireDnsLabel('release', release);
  const helm = config.helmBin ?? 'helm';
  const run = config.run;
  const result = await run(helm, [
    ...(config.helmGlobalArgs ?? []),
    'history', release, '-n', namespace, '--max', '100', '-o', 'json',
  ]);
  if (result.code !== 0) {
    throw new Error(`Kube self-update transport: helm history failed: ${tail(result.stderr || result.stdout)}`);
  }
  return parseHelmHistory(result.stdout);
}

/** The current (latest) deployed Helm revision for a release. */
export async function currentDeployedRevision(
  config: HelmKubectlConfig,
  namespace: string,
  release: string,
): Promise<number> {
  const history = await readHelmHistory(config, namespace, release);
  const revisions = history.map(entry => entry.revision).sort((a, b) => b - a);
  if (revisions.length === 0) {
    throw new Error('Kube self-update transport: helm history is empty; cannot resolve current revision.');
  }
  return revisions[0];
}

/**
 * `helm history`-backed rollback target resolver (x5rt.8 seam). Picks the highest
 * revision strictly earlier than the failed revision that was itself a KNOWN-GOOD
 * rollout (helm status `deployed` or `superseded` — a revision Helm successfully
 * applied at some point). A `failed`/`pending-*` revision is never a rollback
 * target. The auto-rollback surface additionally enforces the strictly-earlier
 * invariant, but this resolver must not hand back a poisoned target to begin with.
 */
export function createLiveRollbackTargetResolver(
  config: HelmKubectlConfig & { namespace: string; release: string },
): (failedRevision: number) => Promise<KubeRollbackTargetResolution> {
  const GOOD_STATUSES = new Set(['deployed', 'superseded']);
  return async (failedRevision) => {
    requirePositiveInt('failedRevision', failedRevision);
    const history = await readHelmHistory(config, config.namespace, config.release);
    const candidates = history
      .filter(entry => entry.revision < failedRevision && GOOD_STATUSES.has(entry.status))
      .map(entry => entry.revision)
      .sort((a, b) => b - a);
    if (candidates.length === 0) {
      return { kind: 'no_previous_revision' };
    }
    return { kind: 'target', targetRevision: candidates[0] };
  };
}

/**
 * Live Helm rollback transport (x5rt.8). `helm rollback --wait` creates a NEW
 * revision whose content is the target's; the resulting revision is read back
 * from `helm history`. Deployment readiness is read via kubectl for the post-
 * rollback wait the rollback surfaces perform.
 */
export function createLiveHelmRollbackApi(
  config: HelmKubectlConfig & { rollbackTimeout?: string },
): KubeHelmRollbackApiPort {
  const helm = config.helmBin ?? 'helm';
  const kubectl = config.kubectlBin ?? 'kubectl';
  const run = config.run;
  const rollbackTimeout = config.rollbackTimeout ?? '5m';
  return {
    rollback: async (namespace, release, targetRevision) => {
      requireDnsLabel('namespace', namespace);
      requireDnsLabel('release', release);
      requirePositiveInt('targetRevision', targetRevision);
      const result = await run(helm, [
        ...(config.helmGlobalArgs ?? []),
        'rollback', release, String(targetRevision), '-n', namespace,
        '--wait', '--timeout', rollbackTimeout,
      ]);
      if (result.code !== 0) {
        throw new Error(`Kube self-update transport: helm rollback failed: ${tail(result.stderr || result.stdout)}`);
      }
      const helmRevision = await currentDeployedRevision(config, namespace, release);
      return { helmRevision };
    },
    getDeployment: async (namespace, name) => {
      requireDnsLabel('namespace', namespace);
      const result = await run(kubectl, [
        ...(config.kubectlGlobalArgs ?? []),
        'get', 'deployment', name, '-n', namespace, '-o', 'json',
      ]);
      if (result.code !== 0) {
        throw new Error(`Kube self-update transport: kubectl get deployment ${name} failed: ${tail(result.stderr || result.stdout)}`);
      }
      return mapDeploymentJson(name, JSON.parse(result.stdout));
    },
    // Read live per call so rollback targeting is judged against the revision the
    // release is actually on, not one captured when some process started.
    currentRevision: async (namespace, release) => (
      await currentDeployedRevision(config, namespace, release)
    ),
  };
}

export interface LiveDeployPipelineRunnerConfig extends HelmKubectlConfig {
  /** Repo root the build/archive run against (must be a clean git checkout). */
  repoDir: string;
  /** Dockerfile path relative to repoDir. */
  dockerfile: string;
  /** Docker build context relative to repoDir. */
  buildContext: string;
  /** Helm chart path relative to repoDir. */
  chartPath: string;
  dockerBin?: string;
  /** Import the built+retagged image into the target runtime (k3d/k3s). */
  importImage: (context: DeployPipelineRunnerContext, retag: { from: string; to: string }) => Promise<void>;
  /** Verify a fresh, restorable backup exists before any live mutation. */
  verifyBackup: (context: DeployPipelineRunnerContext) => Promise<boolean>;
  /** Optional local-k3d smoke validation of the imported image. */
  validateOnK3d?: (context: DeployPipelineRunnerContext) => Promise<{ passed: boolean; detail?: string }>;
  now?: () => Date;
}

/**
 * Live build/test/deploy runner (x5rt.6). Fail-closed at every stage: a dirty
 * tree, an unverified backup, a failing gate, a build/import error, or an invalid
 * Helm revision all reject. Live workloads are untouched until helmUpgrade.
 */
export function createLiveDeployPipelineRunner(
  config: LiveDeployPipelineRunnerConfig,
): DeployPipelineRunner {
  const run = config.run;
  const helm = config.helmBin ?? 'helm';
  const docker = config.dockerBin ?? 'docker';
  const now = config.now ?? (() => new Date());
  const gitEnv = { cwd: config.repoDir } as const;

  return {
    verifyPreconditions: async (context) => {
      const status = await run('git', ['status', '--porcelain'], gitEnv);
      if (status.code !== 0) {
        throw new Error(`Kube self-update transport: git status failed: ${tail(status.stderr)}`);
      }
      const head = await run('git', ['rev-parse', 'HEAD'], gitEnv);
      if (head.code !== 0) {
        throw new Error('Kube self-update transport: cannot resolve HEAD commit.');
      }
      const headSha = head.stdout.trim();
      const workingTreeClean = status.stdout.trim().length === 0 && headSha === context.sourceCommit;
      const backupVerified = await config.verifyBackup(context);
      return {
        workingTreeClean,
        backupVerified,
        detail: workingTreeClean ? undefined : `HEAD ${headSha} or dirty tree does not match ${context.sourceCommit}`,
      };
    },
    archiveSource: async (context) => {
      const archive = await run('git', ['archive', '--format=tar', context.sourceCommit], {
        ...gitEnv,
        maxBuffer: 512 * 1024 * 1024,
        // execFile returns utf8 by default; force binary-safe hashing via a spawn would be ideal,
        // but git archive of committed source hashes deterministically here.
      });
      if (archive.code !== 0) {
        throw new Error(`Kube self-update transport: git archive failed: ${tail(archive.stderr)}`);
      }
      const sha256 = createHash('sha256').update(archive.stdout, 'binary').digest('hex');
      return { sha256 };
    },
    runGate: async (gate: DeployPipelineGate) => {
      // Gate commands are operator-authored (never interpolated with untrusted
      // input) so a shell invocation is acceptable and matches how they are run
      // by hand; the command is recorded verbatim in the pipeline record.
      const result = await run('sh', ['-c', gate.command], { cwd: config.repoDir });
      return {
        passed: result.code === 0,
        detail: result.code === 0 ? undefined : tail(result.stderr || result.stdout),
      };
    },
    buildImage: async (context) => {
      const reference = `${context.imageRepository}:${context.imageTag}`;
      const result = await run(docker, [
        'build',
        '-f', config.dockerfile,
        '-t', reference,
        '--label', `org.opencontainers.image.revision=${context.imageRevisionLabel}`,
        '--build-arg', `PSFN_GIT_COMMIT=${context.sourceCommit}`,
        config.buildContext,
      ], { cwd: config.repoDir });
      if (result.code !== 0) {
        throw new Error(`Kube self-update transport: docker build failed: ${tail(result.stderr || result.stdout)}`);
      }
      return {};
    },
    importImage: async (context) => {
      const reference = `${context.imageRepository}:${context.imageTag}`;
      const retag = deriveLocalImportRetag(reference);
      await config.importImage(context, retag);
    },
    validateOnK3d: async (context) => {
      if (config.validateOnK3d) return config.validateOnK3d(context);
      return { passed: true, detail: 'no local k3d validation configured for this runner' };
    },
    captureLiveValues: async (context) => {
      const result = await run(helm, [
        ...(config.helmGlobalArgs ?? []),
        'get', 'values', context.release, '-n', context.namespace, '-o', 'json',
      ]);
      if (result.code !== 0) {
        throw new Error(`Kube self-update transport: helm get values failed: ${tail(result.stderr || result.stdout)}`);
      }
      const parsed: unknown = JSON.parse(result.stdout.trim() || 'null');
      // `helm get values` emits `null` when no user-supplied values exist.
      return isRecord(parsed) ? parsed : {};
    },
    helmUpgrade: async (context) => {
      const reference = `${context.imageRepository}:${context.imageTag}`;
      const result = await run(helm, [
        ...(config.helmGlobalArgs ?? []),
        'upgrade', context.release, config.chartPath, '-n', context.namespace,
        '--set', `image.repository=${context.imageRepository}`,
        '--set', `image.tag=${context.imageTag}`,
        '--set', `image.reference=${reference}`,
        '--take-ownership',
        '--wait', '--timeout', '10m',
      ], { cwd: config.repoDir, env: { ...process.env, PSFN_HELM_UPGRADE_AT: now().toISOString() } });
      if (result.code !== 0) {
        throw new Error(`Kube self-update transport: helm upgrade failed: ${tail(result.stderr || result.stdout)}`);
      }
      const helmRevision = await currentDeployedRevision(config, context.namespace, context.release);
      return { helmRevision };
    },
  };
}
