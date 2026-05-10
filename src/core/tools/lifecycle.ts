// ── Lifecycle tools ──
// self_restart and self_rebuild tools for the companion to trigger its own restarts.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentMessage } from '@mariozechner/pi-agent-core';
import type { TextContent, ToolResultMessage } from '@mariozechner/pi-ai';
import type { LifecycleNotifier } from '../../system/lifecycle/notifications.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import type { LifecycleRestartSafeguard } from '../../system/capabilities/safeguards.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { PostTurnActionCandidate } from '../../shared/contracts/runtime.js';
import type { PostTurnInferenceContext } from '../agent/substrate-agent/post-turn-actions.js';
import type { PostTurnActionRuntime } from '../agent/post-turn-action-runtime.js';
import { executeSystemReadAction, type SettingsGetParams } from '../../system/settings-tools.js';
import { textResult, textResultWithError } from './results.js';

const log = createComponentLogger('LifecycleTools');
export const DEFERRED_LIFECYCLE_ACTION_KIND = 'lifecycle.execute';
type DeferredLifecycleOperation = 'restart' | 'rebuild';
type SystemAction = 'read' | 'restart' | 'rebuild';

interface DeferredLifecyclePayload {
  operation: DeferredLifecycleOperation;
  reason: string;
}

interface LifecycleToolOptions {
  restartSafeguard?: LifecycleRestartSafeguard;
  getCapabilityTier?: () => CapabilityTier;
  runRestartCommand?: () => Promise<void>;
  runBuildCommand?: () => Promise<void>;
  executionMode?: 'immediate' | 'deferred';
}

interface SystemToolOptions extends LifecycleToolOptions {
  notifier?: LifecycleNotifier;
  stopFn?: () => Promise<void>;
}

interface SystemToolParams extends SettingsGetParams {
  action?: string;
  reason?: string;
}

/**
 * Create the self_restart tool.
 * Sends a pre-restart notification, then exits with code 0.
 * Supervisor (systemd, docker, pm2) handles the actual restart.
 *
 * @param stopFn - async function to cleanly stop the runtime before exit
 */
export function createRestartTool(
  notifier: LifecycleNotifier,
  stopFn: () => Promise<void>,
  options: LifecycleToolOptions = {},
): AgentTool<any> {
  return {
    name: 'self_restart',
    description:
      'Restart yourself. Sends a "brb" message to Discord, cleanly shuts down, ' +
      'and exits. Your process supervisor will restart you automatically. ' +
      'Use when you need a fresh start or after configuration changes.',
    label: 'self_restart',
    parameters: Type.Object({
      reason: Type.String({
        minLength: 1,
        description: 'Reason for restarting (required, logged to safeguard audit trail).',
      }),
    }),
    execute: async (
      _toolCallId: string,
      params: { reason: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
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

      log.info('Self-restart requested', { reason, tier });

      if (options.executionMode === 'deferred') {
        return textResult('Restart queued. It will run after this turn completes.');
      }

      // Send pre-restart notification — must complete before we exit
      await notifier.notifyPreRestart(reason);

      // Schedule clean shutdown + exit after returning the tool result
      // Use setImmediate so the tool result gets back to the LLM first
      setImmediate(async () => {
        try {
          await stopFn();
          if (options.runRestartCommand) {
            await options.runRestartCommand();
            log.info('Ran restart command through configured boundary');
          }
        } catch (err) {
          log.error('Error during shutdown', { error: String(err) });
        }
        process.exit(0);
      });

      return {
        content: [{ type: 'text', text: 'Restart initiated. Sending notification and shutting down...' }] satisfies TextContent[],
        details: {},
      };
    },
  };
}

/**
 * Create the self_rebuild tool.
 * Runs `npm run build`, then restarts (same as self_restart but with a build step).
 */
export function createRebuildTool(
  notifier: LifecycleNotifier,
  stopFn: () => Promise<void>,
  options: LifecycleToolOptions = {},
): AgentTool<any> {
  return {
    name: 'self_rebuild',
    description:
      'Rebuild and restart yourself. Runs `npm run build` first, then restarts. ' +
      'Use after code changes that need recompilation.',
    label: 'self_rebuild',
    parameters: Type.Object({
      reason: Type.String({
        minLength: 1,
        description: 'Reason for rebuilding (required, logged to safeguard audit trail).',
      }),
    }),
    execute: async (
      _toolCallId: string,
      params: { reason: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
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
          if (options.runBuildCommand) {
            log.info('Running configured rebuild command...');
            await options.runBuildCommand();
            log.info('Build complete, shutting down...');
          } else {
            log.warn('No rebuild command configured; skipping build step before shutdown');
          }
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          log.error('Build failed; aborting restart', { error: errorText });
          await notifier.notifyShutdown(`rebuild failed: ${errorText.slice(0, 160)}`);
          return;
        }

        try {
          await stopFn();
          if (options.runRestartCommand) {
            await options.runRestartCommand();
            log.info('Ran restart command through configured boundary after rebuild');
          }
        } catch (err) {
          log.error('Error during shutdown', { error: String(err) });
        }
        process.exit(0);
      });

      return {
        content: [{ type: 'text', text: 'Rebuild initiated. Building, then restarting...' }] satisfies TextContent[],
        details: {},
      };
    },
  };
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
): AgentTool<any> {
  return {
    name: 'system',
    label: 'system',
    description:
      'Unified runtime settings and lifecycle surface. Use action=read|restart|rebuild. '
      + 'Read exposes safe runtime settings; restart and rebuild preserve lifecycle safeguards.',
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
      toolCallId: string,
      params: SystemToolParams = {},
      signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let action: SystemAction;
      try {
        action = normalizeSystemAction(params);
      } catch (error) {
        return textResultWithError(`system failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }

      if (action === 'read') {
        return executeSystemReadAction(config, params);
      }

      if (!options.notifier || !options.stopFn) {
        return textResultWithError(`system action=${action} is not available in this runtime.`, true);
      }

      if (action === 'restart') {
        return createRestartTool(
          options.notifier,
          options.stopFn,
          options,
        ).execute(toolCallId, { reason: params.reason ?? '' }, signal);
      }

      return createRebuildTool(
        options.notifier,
        options.stopFn,
        options,
      ).execute(toolCallId, { reason: params.reason ?? '' }, signal);
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
    runRestartCommand?: () => Promise<void>;
  },
): Promise<void> {
  log.info('Executing deferred self-restart', { reason: payload.reason });
  setImmediate(() => {
    void (async () => {
      try {
        await input.notifier.notifyPreRestart(payload.reason);
        await input.stopFn();
        if (input.runRestartCommand) {
          await input.runRestartCommand();
          log.info('Ran restart command through configured boundary');
        }
      } catch (err) {
        log.error('Error during deferred restart shutdown', { error: String(err) });
      }
      process.exit(0);
    })();
  });
}

async function executeDeferredRebuild(
  payload: DeferredLifecyclePayload,
  input: {
    notifier: LifecycleNotifier;
    stopFn: () => Promise<void>;
    runRestartCommand?: () => Promise<void>;
    runBuildCommand?: () => Promise<void>;
  },
): Promise<void> {
  log.info('Executing deferred self-rebuild', { reason: payload.reason });
  setImmediate(() => {
    void (async () => {
      const fullReason = `rebuild: ${payload.reason}`;
      await input.notifier.notifyPreRestart(fullReason);
      try {
        if (input.runBuildCommand) {
          log.info('Running configured rebuild command...');
          await input.runBuildCommand();
          log.info('Build complete, shutting down...');
        } else {
          log.warn('No rebuild command configured; skipping build step before shutdown');
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        log.error('Build failed; aborting restart', { error: errorText });
        await input.notifier.notifyShutdown(`rebuild failed: ${errorText.slice(0, 160)}`);
        return;
      }

      try {
        await input.stopFn();
        if (input.runRestartCommand) {
          await input.runRestartCommand();
          log.info('Ran restart command through configured boundary after rebuild');
        }
      } catch (err) {
        log.error('Error during deferred rebuild shutdown', { error: String(err) });
      }
      process.exit(0);
    })();
  });
}
