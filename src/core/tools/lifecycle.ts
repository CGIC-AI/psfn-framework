// ── Lifecycle tools ──
// self_restart and self_rebuild tools for the companion to trigger its own restarts.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../agent/tool-surface/descriptions.js';
import type { AgentToolResult, AgentMessage } from '../../boundary/pi-agent/index.js';
import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import type { TextContent, ToolResultMessage } from '@mariozechner/pi-ai';
import type { LifecycleNotifier } from '../../system/lifecycle/notifications.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import type { LifecycleRestartSafeguard } from '../../system/capabilities/safeguards.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { PostTurnActionCandidate } from '../../shared/contracts/runtime.js';
import type { PostTurnInferenceContext } from '../agent/substrate-agent/post-turn-actions.js';
import type { PostTurnActionRuntime } from '../agent/post-turn-action-runtime.js';
import { DEFAULT_REEXEC_RESTART_EXIT_CODE, type RuntimeRestartContract } from '../../system/lifecycle/runtime-mode.js';
import type {
  KubeSelfManagementRequest,
  KubeSelfManagementResponse,
} from '../../system/lifecycle/kube-self-management.js';
import type { KubeLifecycleContext } from '../../system/lifecycle/kube-lifecycle-context.js';
import { executeSystemReadAction, type SettingsGetParams } from '../../system/settings-tools.js';
import { textResult, textResultWithError } from './results.js';

const log = createComponentLogger('LifecycleTools');
export const DEFERRED_LIFECYCLE_ACTION_KIND = 'lifecycle.execute';
const DEFAULT_REBUILD_TIMEOUT_MS = 120_000;
const DEFAULT_REBUILD_MAX_OUTPUT_CHARS = 40_000;
type DeferredLifecycleOperation = 'restart' | 'rebuild';
type SystemAction = 'read' | 'restart' | 'rebuild';

interface DeferredLifecyclePayload {
  operation: DeferredLifecycleOperation;
  reason: string;
}

interface LifecycleToolOptions {
  restartSafeguard?: LifecycleRestartSafeguard;
  getCapabilityTier?: () => CapabilityTier;
  restartContract?: RuntimeRestartContract;
  prepareRestartCommand?: () => Promise<void>;
  runRestartCommand?: () => Promise<void>;
  runBuildCommand?: () => Promise<void>;
  executionMode?: 'immediate' | 'deferred';
}

/**
 * Kube-aware lifecycle seam for the agent process. When the runtime is a guarded
 * Kubernetes deployment, restart/rebuild route through the gateway's
 * approval-gated KubeSelfManagementController instead of the local
 * supervisor/reexec path, and status reporting includes live deployment state.
 */
export interface KubeLifecycleToolRuntime {
  context: KubeLifecycleContext;
  invoke(request: KubeSelfManagementRequest): Promise<KubeSelfManagementResponse>;
}

interface SystemToolOptions extends LifecycleToolOptions {
  notifier?: LifecycleNotifier;
  stopFn?: () => Promise<void>;
  kubeLifecycle?: KubeLifecycleToolRuntime;
}

interface SystemToolParams extends SettingsGetParams {
  action?: string;
  reason?: string;
}

type SupportedRestartStrategy = Exclude<RuntimeRestartContract['strategy'], 'unsupported'>;

type LifecycleRestartPlan =
  | {
    supported: true;
    strategy: SupportedRestartStrategy;
    exitCode: number;
    requiresRestartCommand: boolean;
  }
  | {
    supported: false;
    reason: string;
  };

export interface RepoLifecycleBuildCommandOptions {
  repoRoot?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

function resolveLifecycleRestartPlan(options: LifecycleToolOptions): LifecycleRestartPlan {
  const contract = options.restartContract;
  if (!contract) {
    if (options.runRestartCommand) {
      if (!options.prepareRestartCommand) {
        return {
          supported: false,
          reason: 'restart strategy command is configured without a durable preparation boundary; current process was left running.',
        };
      }
      return {
        supported: true,
        strategy: 'command',
        exitCode: 0,
        requiresRestartCommand: true,
      };
    }
    return {
      supported: true,
      strategy: 'supervisor',
      exitCode: 0,
      requiresRestartCommand: false,
    };
  }

  if (contract.strategy === 'unsupported') {
    return {
      supported: false,
      reason: 'this runtime is not managed by a safe restart supervisor or split-wrapper reexec contract; current process was left running.',
    };
  }

  if (contract.strategy === 'command') {
    if (!contract.command || !options.runRestartCommand || !options.prepareRestartCommand) {
      return {
        supported: false,
        reason: 'restart strategy command is configured without an executable command and durable preparation boundary; current process was left running.',
      };
    }
    return {
      supported: true,
      strategy: 'command',
      exitCode: 0,
      requiresRestartCommand: true,
    };
  }

  if (contract.strategy === 'reexec') {
    return {
      supported: true,
      strategy: 'reexec',
      exitCode: contract.exitCode ?? DEFAULT_REEXEC_RESTART_EXIT_CODE,
      requiresRestartCommand: false,
    };
  }

  return {
    supported: true,
    strategy: 'supervisor',
    exitCode: 0,
    requiresRestartCommand: false,
  };
}

function resolvePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const parsed = Math.floor(Number(value));
  return parsed > 0 ? parsed : fallback;
}

function assertRepoOwnedBuildScript(repoRoot: string): void {
  const packageJsonPath = join(repoRoot, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Lifecycle rebuild requires a readable repo-owned package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Lifecycle rebuild requires package.json to be a JSON object');
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    throw new Error('Lifecycle rebuild requires package.json scripts.build');
  }
  const buildScript = (scripts as { build?: unknown }).build;
  if (typeof buildScript !== 'string' || buildScript.trim().length === 0) {
    throw new Error('Lifecycle rebuild requires package.json scripts.build');
  }
}

export async function runRepoLifecycleBuildCommand(
  options: RepoLifecycleBuildCommandOptions = {},
): Promise<void> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  assertRepoOwnedBuildScript(repoRoot);
  const timeoutMs = resolvePositiveInt(options.timeoutMs, DEFAULT_REBUILD_TIMEOUT_MS);
  const maxOutputChars = resolvePositiveInt(options.maxOutputChars, DEFAULT_REBUILD_MAX_OUTPUT_CHARS);

  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let combinedOutput = '';
    let truncated = false;
    let timedOut = false;

    const appendOutput = (value: Buffer | string): void => {
      const text = typeof value === 'string' ? value : value.toString('utf8');
      if (!text) return;
      const remaining = maxOutputChars - combinedOutput.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      combinedOutput += text.slice(0, remaining);
      if (text.length > remaining) {
        truncated = true;
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    }, timeoutMs);

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectBuild(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        rejectBuild(new Error(`Lifecycle rebuild timed out after ${timeoutMs}ms${combinedOutput ? `\n${combinedOutput}` : ''}`));
        return;
      }
      if (code !== 0) {
        rejectBuild(new Error(
          `Lifecycle rebuild failed with exit code ${code}${truncated ? ' (output truncated)' : ''}${combinedOutput ? `\n${combinedOutput}` : ''}`,
        ));
        return;
      }
      resolveBuild();
    });
  });
}

async function runRestartCommandIfRequired(
  plan: LifecycleRestartPlan & { supported: true },
  options: LifecycleToolOptions,
  notifier: LifecycleNotifier,
  failurePrefix: string,
): Promise<boolean> {
  if (!plan.requiresRestartCommand) {
    return true;
  }

  try {
    await options.runRestartCommand?.();
    log.info('Ran restart command through configured boundary');
    return true;
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    log.error('Restart command failed after durable preparation; runtime remains quiesced with command transport open for explicit retry', {
      error: errorText,
    });
    await notifier.notifyShutdown(`${failurePrefix} failed: ${errorText.slice(0, 160)}`);
    return false;
  }
}

async function completeDurableShutdownForRestart(
  plan: LifecycleRestartPlan & { supported: true },
  stopFn: () => Promise<void>,
  options: LifecycleToolOptions,
  notifier: LifecycleNotifier,
  failurePrefix: string,
): Promise<boolean> {
  if (plan.requiresRestartCommand) {
    const prepareRestartCommand = options.prepareRestartCommand;
    if (!prepareRestartCommand) {
      log.error('Restart command is missing its durable preparation boundary');
      await notifier.notifyShutdown(`${failurePrefix} blocked: durable preparation boundary is unavailable`);
      return false;
    }
    try {
      await prepareRestartCommand();
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      log.error('Durable restart preparation failed; aborting restart command', { error: errorText });
      await notifier.notifyShutdown(`${failurePrefix} blocked: ${errorText.slice(0, 160)}`);
      return false;
    }

    const restartCommandReady = await runRestartCommandIfRequired(
      plan,
      options,
      notifier,
      failurePrefix,
    );
    if (!restartCommandReady) {
      return false;
    }
  }

  try {
    await stopFn();
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    log.error('Durable shutdown failed; aborting restart', { error: errorText });
    await notifier.notifyShutdown(`${failurePrefix} blocked: ${errorText.slice(0, 160)}`);
    return false;
  }
  return true;
}

/**
 * Execute the canonical system action=restart behavior.
 * Sends a pre-restart notification, then exits through the configured
 * supervisor/reexec strategy. Unsupported self-managed runtimes fail closed.
 *
 * @param stopFn - async function to cleanly stop the runtime before exit
 */
async function executeRestartAction(
  notifier: LifecycleNotifier,
  stopFn: () => Promise<void>,
  options: LifecycleToolOptions,
  params: { reason: string },
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const reason = params.reason.trim();
  if (!reason) {
    return textResultWithError('Restart blocked: reason is required.', true);
  }
  const tier = options.getCapabilityTier?.() ?? 'autonomous';
  if (options.restartSafeguard) {
    const decision = options.restartSafeguard.evaluate({
      toolName: 'self_restart',
      reason,
      tier,
    });
    if (!decision.allowed) {
      return textResultWithError(decision.reason, true);
    }
  }
  const restartPlan = resolveLifecycleRestartPlan(options);
  if (!restartPlan.supported) {
    return textResultWithError(`Restart blocked: ${restartPlan.reason}`, true);
  }

  log.info('Self-restart requested', { reason, tier });

  if (options.executionMode === 'deferred') {
    return textResult('Restart queued. It will run after this turn completes.');
  }

  // Send pre-restart notification — must complete before we exit
  await notifier.notifyPreRestart(reason);

  // Schedule clean shutdown + exit after returning the tool result
  // Use setImmediate so the tool result gets back to the LLM first
  setImmediate(async () => {
    const restartCommandReady = await completeDurableShutdownForRestart(
      restartPlan,
      stopFn,
      options,
      notifier,
      'restart',
    );
    if (!restartCommandReady) {
      return;
    }
    process.exit(restartPlan.exitCode);
  });

  return {
    content: [{ type: 'text', text: 'Restart initiated. Sending notification and shutting down...' }] satisfies TextContent[],
    details: {},
  };
}

/**
 * Execute the canonical system action=rebuild behavior.
 * Runs the configured rebuild command, then restarts (same as restart but with a build step).
 */
async function executeRebuildAction(
  notifier: LifecycleNotifier,
  stopFn: () => Promise<void>,
  options: LifecycleToolOptions,
  params: { reason: string },
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const reason = params.reason.trim();
  if (!reason) {
    return textResultWithError('Rebuild blocked: reason is required.', true);
  }
  const tier = options.getCapabilityTier?.() ?? 'autonomous';
  if (options.restartSafeguard) {
    const decision = options.restartSafeguard.evaluate({
      toolName: 'self_rebuild',
      reason,
      tier,
    });
    if (!decision.allowed) {
      return textResultWithError(decision.reason, true);
    }
  }
  const restartPlan = resolveLifecycleRestartPlan(options);
  if (!restartPlan.supported) {
    return textResultWithError(`Rebuild blocked: ${restartPlan.reason}`, true);
  }
  if (!options.runBuildCommand) {
    return textResultWithError(
      'Rebuild blocked: no lifecycle rebuild command is configured; current process was left running.',
      true,
    );
  }
  const runBuildCommand = options.runBuildCommand;
  const fullReason = `rebuild: ${reason}`;

  log.info('Self-rebuild requested', { reason, tier });

  if (options.executionMode === 'deferred') {
    return textResult('Rebuild queued. It will run after this turn completes.');
  }

  // Send pre-restart notification
  await notifier.notifyPreRestart(fullReason);

  // Schedule build + shutdown after tool result returns
  setImmediate(async () => {
    try {
      log.info('Running configured rebuild command...');
      await runBuildCommand();
      log.info('Build complete, shutting down...');
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      log.error('Build failed; aborting restart', { error: errorText });
      await notifier.notifyShutdown(`rebuild failed: ${errorText.slice(0, 160)}`);
      return;
    }

    const restartCommandReady = await completeDurableShutdownForRestart(
      restartPlan,
      stopFn,
      options,
      notifier,
      'rebuild restart',
    );
    if (!restartCommandReady) {
      return;
    }
    process.exit(restartPlan.exitCode);
  });

  return {
    content: [{ type: 'text', text: 'Rebuild initiated. Building, then restarting...' }] satisfies TextContent[],
    details: {},
  };
}

interface KubeDeploymentReadiness {
  name: string;
  readyReplicas: number;
  desiredReplicas: number;
}

function projectDeploymentReadiness(value: unknown): KubeDeploymentReadiness | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string') return null;
  const ready = typeof record.readyReplicas === 'number' ? record.readyReplicas : null;
  const desired = typeof record.desiredReplicas === 'number' ? record.desiredReplicas : null;
  if (ready === null || desired === null) return null;
  return { name: record.name, readyReplicas: ready, desiredReplicas: desired };
}

/**
 * Build a compact kube lifecycle status report: deployment mode plus the current
 * image/Helm/source-revision facts, and (best-effort) live deployment readiness
 * fetched through the gateway's read-only diagnose action.
 */
async function buildKubeLifecycleStatusText(kube: KubeLifecycleToolRuntime): Promise<string> {
  const context = kube.context;
  if (context.deployment !== 'kube') {
    return 'Deployment mode: local (supervisor/reexec lifecycle).';
  }
  const selfManagement = context.selfManagement;
  if (!selfManagement.enabled) {
    return `Deployment mode: kubernetes; guarded self-management: disabled (${selfManagement.reason}).`;
  }
  const lines = [
    'Deployment mode: kubernetes (guarded self-management enabled).',
    `Image: ${selfManagement.targetImage}`,
    `Helm revision: ${selfManagement.helmRevision}`,
    `Source revision: ${selfManagement.sourceRevision}`,
  ];
  try {
    const diagnose = await kube.invoke({
      action: 'diagnose',
      namespace: selfManagement.namespace,
      release: selfManagement.release,
    });
    if (diagnose.status === 'completed' && diagnose.details) {
      const rawDeployments = (diagnose.details as { deployments?: unknown }).deployments;
      const deployments = Array.isArray(rawDeployments)
        ? rawDeployments.map(projectDeploymentReadiness).filter((d): d is KubeDeploymentReadiness => d !== null)
        : [];
      if (deployments.length > 0) {
        lines.push('Deployments:');
        for (const deployment of deployments) {
          lines.push(`  ${deployment.name}: ready ${deployment.readyReplicas}/${deployment.desiredReplicas}`);
        }
      }
    }
  } catch (err) {
    lines.push(`Live deployment state unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return lines.join('\n');
}

async function appendKubeLifecycleStatus(
  settingsResult: AgentToolResult<{ isError?: boolean }>,
  kube: KubeLifecycleToolRuntime,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const statusText = await buildKubeLifecycleStatusText(kube);
  return {
    ...settingsResult,
    content: [
      ...settingsResult.content,
      { type: 'text', text: `\n\n${statusText}` },
    ] satisfies TextContent[],
  };
}

/**
 * Execute action=restart under a guarded Kubernetes deployment: route a rollout
 * restart through the gateway's approval-gated controller. Fails closed (never a
 * local reexec) when self-management is unavailable.
 */
async function executeKubeRestartAction(
  kube: KubeLifecycleToolRuntime,
  options: LifecycleToolOptions,
  params: { reason: string },
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const reason = params.reason.trim();
  if (!reason) {
    return textResultWithError('Restart blocked: reason is required.', true);
  }
  const tier = options.getCapabilityTier?.() ?? 'autonomous';
  if (options.restartSafeguard) {
    const decision = options.restartSafeguard.evaluate({
      toolName: 'self_restart',
      reason,
      tier,
    });
    if (!decision.allowed) {
      return textResultWithError(decision.reason, true);
    }
  }
  const context = kube.context;
  const selfManagement = context.deployment === 'kube' ? context.selfManagement : null;
  if (!selfManagement || !selfManagement.enabled) {
    const detail = selfManagement
      ? selfManagement.reason
      : 'the Kubernetes deployment scope is unavailable';
    return textResultWithError(
      `Restart blocked: ${detail}. No local restart was performed under Kubernetes.`,
      true,
    );
  }

  log.info('Self-restart requested (kube rollout)', { reason, tier });

  let response: KubeSelfManagementResponse;
  try {
    response = await kube.invoke({
      action: 'restart',
      namespace: selfManagement.namespace,
      release: selfManagement.release,
      sourceRevision: selfManagement.sourceRevision,
      targetImage: selfManagement.targetImage,
      helmRevision: selfManagement.helmRevision,
      reason,
    });
  } catch (err) {
    return textResultWithError(
      `Restart failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }

  if (response.status === 'approval_required') {
    return textResult(
      'Rollout restart of the psfn-agent, psfn-gateway, and psfn-garden deployments is queued for operator approval '
      + `(approval ${response.approvalId}). It will not run until an operator approves; you will not be restarted before then.`,
    );
  }

  return textResult(
    `Rollout restart completed (validation: ${response.validationResult}). `
    + 'The psfn-agent, psfn-gateway, and psfn-garden deployments were restarted and reported ready.',
  );
}

/**
 * Execute action=rebuild under a guarded Kubernetes deployment: refuse loudly and
 * point at the guarded build/deploy pipeline. Building an image in the running
 * pod is never performed in kube mode.
 */
function executeKubeRebuildRefusal(
  params: { reason: string },
): AgentToolResult<{ isError?: boolean }> {
  const reason = params.reason.trim();
  if (!reason) {
    return textResultWithError('Rebuild blocked: reason is required.', true);
  }
  return textResultWithError(
    'Rebuild does not run in-pod under Kubernetes: building an image inside the running container is unsupported and '
    + 'unsafe. Route the change through the guarded build-test-image deploy pipeline (bead psfn-framework-x5rt.6), which '
    + 'builds a pinned image, validates it, and rolls it out under operator approval. No local build was performed.',
    true,
  );
}

function normalizeSystemAction(params: SystemToolParams): SystemAction {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  switch (action) {
    case '':
    case 'read':
    case 'settings_get':
      return 'read';
    case 'restart':
    case 'self_restart':
      return 'restart';
    case 'rebuild':
    case 'self_rebuild':
      return 'rebuild';
    default:
      throw new Error(`Unknown system action "${action}". Use action=read|restart|rebuild.`);
  }
}

export function createSystemTool(
  config: SubstrateConfig,
  options: SystemToolOptions = {},
): SubstrateAgentTool {
  return {
    name: 'system',
    label: 'system',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.system,
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('read'),
        Type.Literal('settings_get'),
        Type.Literal('restart'),
        Type.Literal('self_restart'),
        Type.Literal('rebuild'),
        Type.Literal('self_rebuild'),
      ], {
        description: 'System action. Preferred actions: read, restart, rebuild. Legacy action aliases remain accepted.',
      })),
      key: Type.Optional(Type.String({ description: 'Used with action=read. Single settings key to retrieve.' })),
      keys: Type.Optional(Type.Array(Type.String(), { description: 'Used with action=read. Subset of settings keys to retrieve.' })),
      list: Type.Optional(Type.Boolean({ description: 'Used with action=read. Return available safe keys.' })),
      reason: Type.Optional(Type.String({
        minLength: 1,
        description: 'Used with action=restart|rebuild. Required, logged to safeguard audit trail.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: SystemToolParams = {},
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let action: SystemAction;
      try {
        action = normalizeSystemAction(params);
      } catch (error) {
        return textResultWithError(`system failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }

      if (action === 'read') {
        const settingsResult = executeSystemReadAction(config, params);
        if (options.kubeLifecycle) {
          return await appendKubeLifecycleStatus(settingsResult, options.kubeLifecycle);
        }
        return settingsResult;
      }

      // Under a Kubernetes deployment, lifecycle mutation must route through the
      // gateway's approval-gated controller and never fall back to the local
      // supervisor/reexec path (fail closed).
      if (options.kubeLifecycle && options.kubeLifecycle.context.deployment === 'kube') {
        if (action === 'restart') {
          return await executeKubeRestartAction(
            options.kubeLifecycle,
            options,
            { reason: params.reason ?? '' },
          );
        }
        return executeKubeRebuildRefusal({ reason: params.reason ?? '' });
      }

      if (!options.notifier || !options.stopFn) {
        return textResultWithError(`system action=${action} is not available in this runtime.`, true);
      }

      if (action === 'restart') {
        return executeRestartAction(
          options.notifier,
          options.stopFn,
          options,
          { reason: params.reason ?? '' },
        );
      }

      return executeRebuildAction(
        options.notifier,
        options.stopFn,
        options,
        { reason: params.reason ?? '' },
      );
    },
  };
}

export function inferDeferredLifecycleActions(
  context: PostTurnInferenceContext,
): PostTurnActionCandidate[] {
  const requestedByToolCallId = new Map<string, DeferredLifecyclePayload>();

  for (const message of context.turnMessages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    for (const content of message.content) {
      if (content.type !== 'toolCall' || typeof content.id !== 'string') {
        continue;
      }
      const payload = normalizeDeferredLifecyclePayloadFromToolCall(
        content.name,
        content.arguments,
      );
      if (!payload) {
        continue;
      }
      requestedByToolCallId.set(content.id, payload);
    }
  }

  const inferred: PostTurnActionCandidate[] = [];
  for (const message of context.turnMessages) {
    if (!isSuccessfulLifecycleToolResult(message)) {
      continue;
    }
    const payload = message.toolCallId
      ? requestedByToolCallId.get(message.toolCallId)
      : undefined;
    if (!payload) {
      continue;
    }
    inferred.push({
      kind: DEFERRED_LIFECYCLE_ACTION_KIND,
      payload: {
        operation: payload.operation,
        reason: payload.reason,
      },
      dedupeKey: `${DEFERRED_LIFECYCLE_ACTION_KIND}:${context.turnId}:${payload.operation}`,
    });
  }

  return inferred;
}

export function registerDeferredLifecycleRuntime(input: {
  agentLoop: {
    registerPostTurnActionInferer?(inferer: (context: PostTurnInferenceContext) => PostTurnActionCandidate[]): () => void;
  };
  postTurnActions: PostTurnActionRuntime;
  notifier: LifecycleNotifier;
  stopFn: () => Promise<void>;
  restartContract?: RuntimeRestartContract;
  prepareRestartCommand?: () => Promise<void>;
  runRestartCommand?: () => Promise<void>;
  runBuildCommand?: () => Promise<void>;
}): () => void {
  const unregisterInferer = input.agentLoop.registerPostTurnActionInferer?.(inferDeferredLifecycleActions)
    ?? (() => undefined);
  const unregisterHandler = input.postTurnActions.registerHandler(
    DEFERRED_LIFECYCLE_ACTION_KIND,
    async (action) => {
      const payload = normalizeDeferredLifecyclePayload(action.payload);
      if (!payload) {
        throw new Error(`Deferred lifecycle action "${action.id}" is missing required payload fields`);
      }
      if (payload.operation === 'restart') {
        await executeDeferredRestart(payload, input);
        return;
      }
      await executeDeferredRebuild(payload, input);
    },
    { executionMode: 'background' },
  );

  return () => {
    unregisterHandler();
    unregisterInferer();
  };
}

function normalizeDeferredLifecyclePayloadFromToolCall(
  toolName: unknown,
  args: unknown,
): DeferredLifecyclePayload | null {
  if (toolName !== 'self_restart' && toolName !== 'self_rebuild' && toolName !== 'system') {
    return null;
  }
  const reason = normalizeReason(args);
  if (!reason) {
    return null;
  }
  if (toolName === 'system') {
    const action = normalizeSystemActionFromArgs(args);
    if (!action || action === 'read') {
      return null;
    }
    return {
      operation: action,
      reason,
    };
  }
  return {
    operation: toolName === 'self_restart' ? 'restart' : 'rebuild',
    reason,
  };
}

function normalizeDeferredLifecyclePayload(payload: unknown): DeferredLifecyclePayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const operation = (payload as { operation?: unknown }).operation;
  const reason = normalizeReason(payload);
  if ((operation !== 'restart' && operation !== 'rebuild') || !reason) {
    return null;
  }
  return {
    operation,
    reason,
  };
}

function normalizeReason(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  const value = (payload as { reason?: unknown }).reason;
  if (typeof value === 'string') {
    return value.trim();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  for (const key of ['note', 'marker', 'text', 'value', 'primary_reason', 'primaryReason'] as const) {
    const nested = (value as Record<string, unknown>)[key];
    if (typeof nested === 'string' && nested.trim().length > 0) {
      return nested.trim();
    }
  }
  return '';
}

function normalizeSystemActionFromArgs(payload: unknown): SystemAction | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const rawAction = (payload as { action?: unknown }).action;
  if (typeof rawAction !== 'string') {
    return 'read';
  }
  const normalized = rawAction.trim();
  if (!normalized || normalized === 'read' || normalized === 'settings_get') {
    return 'read';
  }
  if (normalized === 'restart' || normalized === 'self_restart') {
    return 'restart';
  }
  if (normalized === 'rebuild' || normalized === 'self_rebuild') {
    return 'rebuild';
  }
  return null;
}

function isSuccessfulLifecycleToolResult(message: AgentMessage): message is ToolResultMessage {
  if (message.role !== 'toolResult' || message.isError === true) {
    return false;
  }
  return message.toolName === 'self_restart' || message.toolName === 'self_rebuild' || message.toolName === 'system';
}

async function executeDeferredRestart(
  payload: DeferredLifecyclePayload,
  input: {
    notifier: LifecycleNotifier;
    stopFn: () => Promise<void>;
    restartContract?: RuntimeRestartContract;
    prepareRestartCommand?: () => Promise<void>;
    runRestartCommand?: () => Promise<void>;
  },
): Promise<void> {
  log.info('Executing deferred self-restart', { reason: payload.reason });
  const restartPlan = resolveLifecycleRestartPlan(input);
  if (!restartPlan.supported) {
    log.warn('Deferred self-restart blocked by runtime restart strategy', {
      reason: restartPlan.reason,
    });
    await input.notifier.notifyShutdown(`restart blocked: ${restartPlan.reason.slice(0, 160)}`);
    return;
  }
  setImmediate(() => {
    void (async () => {
      try {
        await input.notifier.notifyPreRestart(payload.reason);
        const restartCommandReady = await completeDurableShutdownForRestart(
          restartPlan,
          input.stopFn,
          input,
          input.notifier,
          'restart',
        );
        if (!restartCommandReady) {
          return;
        }
      } catch (err) {
        log.error('Error during deferred restart shutdown', { error: String(err) });
        return;
      }
      process.exit(restartPlan.exitCode);
    })();
  });
}

async function executeDeferredRebuild(
  payload: DeferredLifecyclePayload,
  input: {
    notifier: LifecycleNotifier;
    stopFn: () => Promise<void>;
    restartContract?: RuntimeRestartContract;
    prepareRestartCommand?: () => Promise<void>;
    runRestartCommand?: () => Promise<void>;
    runBuildCommand?: () => Promise<void>;
  },
): Promise<void> {
  log.info('Executing deferred self-rebuild', { reason: payload.reason });
  const restartPlan = resolveLifecycleRestartPlan(input);
  if (!restartPlan.supported) {
    log.warn('Deferred self-rebuild blocked by runtime restart strategy', {
      reason: restartPlan.reason,
    });
    await input.notifier.notifyShutdown(`rebuild blocked: ${restartPlan.reason.slice(0, 160)}`);
    return;
  }
  if (!input.runBuildCommand) {
    log.warn('Deferred self-rebuild blocked because no lifecycle rebuild command is configured');
    await input.notifier.notifyShutdown('rebuild blocked: no lifecycle rebuild command is configured');
    return;
  }
  const runBuildCommand = input.runBuildCommand;
  setImmediate(() => {
    void (async () => {
      const fullReason = `rebuild: ${payload.reason}`;
      await input.notifier.notifyPreRestart(fullReason);
      try {
        log.info('Running configured rebuild command...');
        await runBuildCommand();
        log.info('Build complete, shutting down...');
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        log.error('Build failed; aborting restart', { error: errorText });
        await input.notifier.notifyShutdown(`rebuild failed: ${errorText.slice(0, 160)}`);
        return;
      }

      try {
        const restartCommandReady = await completeDurableShutdownForRestart(
          restartPlan,
          input.stopFn,
          input,
          input.notifier,
          'rebuild restart',
        );
        if (!restartCommandReady) {
          return;
        }
      } catch (err) {
        log.error('Error during deferred rebuild shutdown', { error: String(err) });
        return;
      }
      process.exit(restartPlan.exitCode);
    })();
  });
}
