// ── Operator-job entrypoint: kube self-update -> validate -> auto-rollback ──
//
// The single production caller that wires the x5rt.6/.7/.8 seams into a live
// flow via runKubeSelfUpdateJob (x5rt.9 composition). It constructs the
// credential-bearing docker/helm/kubectl transports here — in the operator
// process — and never in the agent, preserving the x5rt.10 separation. Invoked
// by the operator (or CI) after an approved deploy is dispatched; it builds the
// pinned image, rolls it out, validates the live companion, and on a bound,
// unhealthy verdict rolls back exactly once through the durable act-once ledger.
//
// Fail-closed: any missing/invalid pinned config aborts before touching the
// cluster; a deploy that fails before the Helm upgrade leaves live untouched.

import { createComponentLogger } from '../../shared/logger.js';
import {
  isKubeDnsLabel,
  isKubeSourceRevision,
  isPinnedKubeImageReference,
} from '../../system/lifecycle/kube-self-management.js';
import type { DeployPipelinePlan } from '../../system/lifecycle/kube-deploy-pipeline.js';
import { isExplicitTrue } from '../startup/support/env-parsing.js';
import {
  createLiveDeployPipelineRunner,
  createLiveHelmRollbackApi,
  createLiveRollbackTargetResolver,
  execFileCommandRunner,
  type CommandRunner,
} from './kube-self-update-transport.js';
import {
  createHttpChatTurnProbe,
  createKubectlExecProbe,
  createLivePostRolloutValidationRunner,
  type HttpJsonFetcher,
} from './kube-self-update-validation-transport.js';
import type { ToolConformanceRunResult } from '../../core/agent/tool-conformance/types.js';
import type { RuntimeDiagnosticsSnapshot } from '../../shared/diagnostics/runtime-diagnostics.js';
import type { ToolConformanceSkipped } from '../../system/lifecycle/kube-post-rollout-validation.js';
import { runKubeSelfUpdateJob, type KubeSelfUpdateJobOptions } from '../../system/lifecycle/kube-self-update-job.js';

const log = createComponentLogger('KubeSelfUpdateJob');

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim() ?? '';
  if (value.length === 0) {
    throw new Error(`Kube self-update job requires ${key}.`);
  }
  return value;
}

function splitPinnedImage(reference: string): { repository: string; tag: string } {
  if (!isPinnedKubeImageReference(reference)) {
    throw new Error('Kube self-update job PSFN_KUBE_TARGET_IMAGE must be an exact pinned image reference.');
  }
  const lastSlash = reference.lastIndexOf('/');
  const lastColon = reference.lastIndexOf(':');
  if (!(lastColon > lastSlash)) {
    throw new Error('Kube self-update job PSFN_KUBE_TARGET_IMAGE must include an explicit tag.');
  }
  return { repository: reference.slice(0, lastColon), tag: reference.slice(lastColon + 1) };
}

export interface KubeSelfUpdateJobEnvConfig {
  plan: DeployPipelinePlan;
  namespace: string;
  release: string;
  resourcePrefix: string;
  systemDataDir: string;
  repoDir: string;
  dockerfile: string;
  buildContext: string;
  chartPath: string;
  gardenHealthUrl: string;
  modelRouteUrl: string;
  expectedModelId: string;
  chatCompletionsUrl: string;
  pgPodSelector: string;
  redisPodSelector: string;
  agentPodSelector: string;
  conformanceCommand: string[];
  diagnosticsCommand: string[];
  helmGlobalArgs: string[];
  kubectlGlobalArgs: string[];
  autoRollbackEnabled: boolean;
}

function parseCommandArray(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key]?.trim();
  if (!raw) throw new Error(`Kube self-update job requires ${key} (a JSON array of command args).`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Kube self-update job ${key} must be a JSON array of strings.`);
  }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string') || parsed.length === 0) {
    throw new Error(`Kube self-update job ${key} must be a non-empty JSON array of strings.`);
  }
  return parsed as string[];
}

function parseOptionalArgs(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key]?.trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new Error(`Kube self-update job ${key} must be a JSON array of strings.`);
  }
  return parsed as string[];
}

/**
 * Resolve and validate the operator-job configuration from the environment.
 * Fail-closed: every pinned/required value is validated before any transport is
 * constructed. Exported for unit coverage of the fail-closed contract.
 */
export function resolveKubeSelfUpdateJobEnvConfig(
  env: NodeJS.ProcessEnv,
): KubeSelfUpdateJobEnvConfig {
  if (!isExplicitTrue(env.PSFN_KUBE_SELF_UPDATE_ENABLED)) {
    throw new Error('Kube self-update job is disabled; set PSFN_KUBE_SELF_UPDATE_ENABLED=true to run it.');
  }
  const namespace = requireEnv(env, 'PSFN_HELM_NAMESPACE');
  const release = requireEnv(env, 'PSFN_HELM_RELEASE_NAME');
  const resourcePrefix = requireEnv(env, 'PSFN_KUBE_RESOURCE_PREFIX');
  if (!isKubeDnsLabel(namespace) || !isKubeDnsLabel(release) || !isKubeDnsLabel(resourcePrefix)) {
    throw new Error('Kube self-update job namespace, release, and resource prefix must be DNS labels.');
  }
  const sourceCommit = requireEnv(env, 'PSFN_GIT_COMMIT');
  if (!isKubeSourceRevision(sourceCommit)) {
    throw new Error('Kube self-update job PSFN_GIT_COMMIT must be an exact 40-character Git revision.');
  }
  const sourceBranch = requireEnv(env, 'PSFN_SOURCE_BRANCH');
  const { repository, tag } = splitPinnedImage(requireEnv(env, 'PSFN_KUBE_TARGET_IMAGE'));

  const plan: DeployPipelinePlan = {
    action: 'deploy',
    namespace,
    release,
    sourceBranch,
    sourceCommit,
    imageRepository: repository,
    imageTag: tag,
    k3dValidation: env.PSFN_K3D_VALIDATION === 'run'
      ? { mode: 'run' }
      : { mode: 'skip', reason: env.PSFN_K3D_VALIDATION_SKIP_REASON?.trim() || 'k3d validation not configured for this job' },
  };

  return {
    plan,
    namespace,
    release,
    resourcePrefix,
    systemDataDir: requireEnv(env, 'PSFN_SYSTEM_DATA_DIR'),
    repoDir: requireEnv(env, 'PSFN_REPO_DIR'),
    dockerfile: requireEnv(env, 'PSFN_DOCKERFILE'),
    buildContext: env.PSFN_BUILD_CONTEXT?.trim() || '.',
    chartPath: requireEnv(env, 'PSFN_CHART_PATH'),
    gardenHealthUrl: requireEnv(env, 'PSFN_GARDEN_HEALTH_URL'),
    modelRouteUrl: requireEnv(env, 'PSFN_MODEL_ROUTE_URL'),
    expectedModelId: requireEnv(env, 'PSFN_EXPECTED_MODEL_ID'),
    chatCompletionsUrl: requireEnv(env, 'PSFN_CHAT_COMPLETIONS_URL'),
    pgPodSelector: env.PSFN_PG_POD_SELECTOR?.trim() || 'app.kubernetes.io/component=postgres',
    redisPodSelector: env.PSFN_REDIS_POD_SELECTOR?.trim() || 'app.kubernetes.io/component=redis',
    agentPodSelector: env.PSFN_AGENT_POD_SELECTOR?.trim() || 'app.kubernetes.io/component=agent',
    conformanceCommand: parseCommandArray(env, 'PSFN_CONFORMANCE_EXEC_CMD'),
    diagnosticsCommand: parseCommandArray(env, 'PSFN_DIAGNOSTICS_EXEC_CMD'),
    helmGlobalArgs: parseOptionalArgs(env, 'PSFN_HELM_GLOBAL_ARGS'),
    kubectlGlobalArgs: parseOptionalArgs(env, 'PSFN_KUBECTL_GLOBAL_ARGS'),
    autoRollbackEnabled: env.PSFN_AUTO_ROLLBACK_ENABLED
      ? isExplicitTrue(env.PSFN_AUTO_ROLLBACK_ENABLED)
      : true,
  };
}

export interface BuildKubeSelfUpdateJobOptionsDeps {
  run?: CommandRunner;
  http?: HttpJsonFetcher;
  /** Import the built+retagged image into the runtime; supplied by the operator env. */
  importImage: KubeSelfUpdateJobOptions['deployRunner']['importImage'];
  /** Verify a fresh restorable backup exists before mutation. */
  verifyBackup: (context: { namespace: string; release: string }) => Promise<boolean>;
}

/** Compose the full self-update job options from resolved config + live transports. */
export function buildKubeSelfUpdateJobOptions(
  config: KubeSelfUpdateJobEnvConfig,
  deps: BuildKubeSelfUpdateJobOptionsDeps,
): KubeSelfUpdateJobOptions {
  const run = deps.run ?? execFileCommandRunner;
  const helmKubectl = {
    run,
    helmGlobalArgs: config.helmGlobalArgs,
    kubectlGlobalArgs: config.kubectlGlobalArgs,
  } as const;

  const kubectlExec = {
    run,
    kubectlGlobalArgs: config.kubectlGlobalArgs,
    namespace: config.namespace,
  } as const;

  const fetchExecJson = async <T>(command: string[], podSelector: string, label: string): Promise<T> => {
    const podResult = await run('kubectl', [
      ...config.kubectlGlobalArgs,
      'get', 'pods', '-n', config.namespace, '-l', podSelector,
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    const podName = podResult.stdout.trim();
    if (podResult.code !== 0 || podName.length === 0) {
      throw new Error(`Kube self-update job: no pod for ${label} (selector ${podSelector}).`);
    }
    const execResult = await run('kubectl', [
      ...config.kubectlGlobalArgs,
      'exec', podName, '-n', config.namespace, '--', ...command,
    ]);
    if (execResult.code !== 0) {
      throw new Error(`Kube self-update job: ${label} exec failed: ${(execResult.stderr || execResult.stdout).trim().slice(-300)}`);
    }
    return JSON.parse(execResult.stdout) as T;
  };

  const validationRunner = createLivePostRolloutValidationRunner({
    namespace: config.namespace,
    resourcePrefix: config.resourcePrefix,
    run,
    ...(deps.http ? { http: deps.http } : {}),
    kubectlGlobalArgs: config.kubectlGlobalArgs,
    gardenHealthUrl: config.gardenHealthUrl,
    modelRouteUrl: config.modelRouteUrl,
    expectedModelId: config.expectedModelId,
    chatTurnProbe: createHttpChatTurnProbe({
      ...(deps.http ? { http: deps.http } : {}),
      chatCompletionsUrl: config.chatCompletionsUrl,
      model: config.expectedModelId,
    }),
    pgVectorProbe: createKubectlExecProbe({
      ...kubectlExec,
      podSelector: config.pgPodSelector,
      command: ['psql', '-tAc', "SELECT extname FROM pg_extension WHERE extname='vector'"],
      expectSubstring: 'vector',
    }),
    redisProbe: createKubectlExecProbe({
      ...kubectlExec,
      podSelector: config.redisPodSelector,
      command: ['redis-cli', 'PING'],
      expectSubstring: 'PONG',
    }),
    fetchToolConformance: (): Promise<ToolConformanceRunResult | ToolConformanceSkipped> =>
      fetchExecJson<ToolConformanceRunResult>(config.conformanceCommand, config.agentPodSelector, 'tool conformance'),
    fetchDiagnostics: (): Promise<RuntimeDiagnosticsSnapshot> =>
      fetchExecJson<RuntimeDiagnosticsSnapshot>(config.diagnosticsCommand, config.agentPodSelector, 'diagnostics'),
  });

  const deployRunner = createLiveDeployPipelineRunner({
    ...helmKubectl,
    repoDir: config.repoDir,
    dockerfile: config.dockerfile,
    buildContext: config.buildContext,
    chartPath: config.chartPath,
    importImage: deps.importImage,
    verifyBackup: (context) => deps.verifyBackup({ namespace: context.namespace, release: context.release }),
  });

  const helmRollbackApi = createLiveHelmRollbackApi(helmKubectl);
  const resolveRollbackTarget = createLiveRollbackTargetResolver({
    ...helmKubectl,
    namespace: config.namespace,
    release: config.release,
  });

  return {
    plan: config.plan,
    systemDataDir: config.systemDataDir,
    resourcePrefix: config.resourcePrefix,
    deployRunner,
    postRolloutValidationRunner: validationRunner,
    ...(config.autoRollbackEnabled
      ? { autoRollback: { api: helmRollbackApi, resolveRollbackTarget } }
      : {}),
    audit: async (event) => {
      log.info('auto-rollback decision', {
        status: event.status,
        release: event.release,
        currentHelmRevision: event.currentHelmRevision,
        ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        ...(event.targetHelmRevision !== undefined ? { targetHelmRevision: event.targetHelmRevision } : {}),
      });
    },
  };
}

async function main(): Promise<void> {
  const config = resolveKubeSelfUpdateJobEnvConfig(process.env);
  const options = buildKubeSelfUpdateJobOptions(config, {
    // The concrete image import + backup verification are operator-environment
    // specific; they are wired here from env-provided commands so the agent
    // never carries them. Absent configuration fails closed.
    importImage: async (context, retag) => {
      const cmd = process.env.PSFN_IMPORT_IMAGE_CMD?.trim();
      if (!cmd) throw new Error('Kube self-update job requires PSFN_IMPORT_IMAGE_CMD to import the built image.');
      const result = await execFileCommandRunner('sh', ['-c', cmd], {
        env: {
          ...process.env,
          PSFN_IMPORT_FROM: retag.from,
          PSFN_IMPORT_TO: retag.to,
          PSFN_IMPORT_REFERENCE: `${context.imageRepository}:${context.imageTag}`,
        },
      });
      if (result.code !== 0) {
        throw new Error(`Kube self-update job image import failed: ${(result.stderr || result.stdout).trim().slice(-300)}`);
      }
    },
    verifyBackup: async () => {
      const cmd = process.env.PSFN_VERIFY_BACKUP_CMD?.trim();
      if (!cmd) throw new Error('Kube self-update job requires PSFN_VERIFY_BACKUP_CMD to verify a restorable backup.');
      const result = await execFileCommandRunner('sh', ['-c', cmd]);
      return result.code === 0;
    },
  });

  const result = await runKubeSelfUpdateJob(options);
  log.info('self-update job complete', {
    outcome: result.pipeline.outcome,
    ...(result.pipeline.failedStage ? { failedStage: result.pipeline.failedStage } : {}),
    helmRevision: result.pipeline.helmRevision,
    autoRollback: result.autoRollback.status,
  });

  if (result.pipeline.outcome === 'succeeded' && result.autoRollback.status === 'healthy') {
    process.exit(0);
  }
  if (result.autoRollback.status === 'rolled_back') {
    // The safety net recovered the release; the deploy itself failed validation.
    process.exit(2);
  }
  // Any other terminal state (surfaced/no_previous_revision/rollback_failed/skipped
  // on a failed deploy) is a non-clean outcome the operator must inspect.
  process.exit(1);
}

// Only run when invoked directly as the operator job (not when imported for tests).
if (process.argv[1] && process.argv[1].endsWith('kube-self-update-job-main.ts')
  || process.argv[1] && process.argv[1].endsWith('kube-self-update-job-main.js')) {
  main().catch((error) => {
    log.error('Fatal error', { error: String(error) });
    process.exit(1);
  });
}
