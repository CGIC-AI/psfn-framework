// ── System tool ──
// Unified runtime settings and lifecycle controls for the companion.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import { spawn } from 'node:child_process';
import type { LifecycleNotifier } from '../lifecycle/notifications.js';
import { normalizeRestartCommand, type RuntimeMode } from '../lifecycle/runtime-mode.js';
import { createComponentLogger } from '../logger.js';
import type { CapabilityTier } from '../types.js';
import type { LifecycleRestartSafeguard } from '../capabilities/safeguards.js';
import type { SubstrateConfig } from '../types.js';
import { executeSystemReadAction, type SettingsReadParams } from '../settings-tools.js';
import type { LegacyAliasTelemetryCallback } from './legacy-alias-telemetry.js';
import { textResultWithError } from './results.js';
import { toErrorMessage } from '../utils/errors.js';

const log = createComponentLogger('LifecycleTools');

interface LifecycleToolOptions {
  restartSafeguard?: LifecycleRestartSafeguard;
  getCapabilityTier?: () => CapabilityTier;
  restartCommand?: string;
  runtimeMode?: RuntimeMode;
}

type SystemAction = 'read' | 'restart' | 'rebuild';

interface SystemToolParams extends SettingsReadParams {
  reason?: string;
}

interface SystemToolOptions extends LifecycleToolOptions {
  emitLegacyAliasTelemetry?: LegacyAliasTelemetryCallback;
  notifier?: LifecycleNotifier;
  stopFn?: () => Promise<void>;
  restartStopFn?: () => Promise<void>;
  rebuildStopFn?: () => Promise<void>;
}

async function launchRestartCommand(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
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
      throw new Error(
        `Unknown system action "${action}". Use action=read|restart|rebuild.`,
      );
  }
}

function getLifecycleDeps(
  options: SystemToolOptions,
  action: Exclude<SystemAction, 'read'>,
): { notifier: LifecycleNotifier; stopFn: () => Promise<void> } | AgentToolResult<{ isError?: boolean }> {
  const stopFn = action === 'restart'
    ? (options.restartStopFn ?? options.stopFn)
    : (options.rebuildStopFn ?? options.stopFn);
  if (options.notifier && stopFn) {
    return {
      notifier: options.notifier,
      stopFn,
    };
  }

  return textResultWithError(`system action=${action} is not available in this runtime.`, true);
}

async function executeRestartAction(
  params: SystemToolParams,
  options: SystemToolOptions,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const deps = getLifecycleDeps(options, 'restart');
  if ('content' in deps) return deps;

  const reason = params.reason?.trim() ?? '';
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
  await deps.notifier.notifyPreRestart(reason);
  const restartCommand = normalizeRestartCommand(options.restartCommand);

  setImmediate(async () => {
    try {
      await deps.stopFn();
      if (restartCommand) {
        await launchRestartCommand(restartCommand);
        log.info('Spawned restart command', {
          runtimeMode: options.runtimeMode ?? 'unknown',
        });
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
}

async function executeRebuildAction(
  params: SystemToolParams,
  options: SystemToolOptions,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const deps = getLifecycleDeps(options, 'rebuild');
  if ('content' in deps) return deps;

  const reason = params.reason?.trim() ?? '';
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
  const restartCommand = normalizeRestartCommand(options.restartCommand);

  log.info('Self-rebuild requested', { reason, tier });
  await deps.notifier.notifyPreRestart(fullReason);

  setImmediate(async () => {
    try {
      const { execSync } = await import('node:child_process');
      log.info('Running npm run build...');
      execSync('npm run build', {
        cwd: process.cwd(),
        stdio: 'pipe',
        timeout: 120_000,
      });
      log.info('Build complete, shutting down...');
    } catch (err) {
      const errorText = toErrorMessage(err);
      log.error('Build failed; aborting restart', { error: errorText });
      await deps.notifier.notifyShutdown(`rebuild failed: ${errorText.slice(0, 160)}`);
      return;
    }

    try {
      await deps.stopFn();
      if (restartCommand) {
        await launchRestartCommand(restartCommand);
        log.info('Spawned restart command after rebuild', {
          runtimeMode: options.runtimeMode ?? 'unknown',
        });
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
      _toolCallId: string,
      params: SystemToolParams = {},
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
      let action: SystemAction;
      try {
        action = normalizeSystemAction(params);
        if (rawAction && rawAction !== action) {
          options.emitLegacyAliasTelemetry?.({
            toolName: 'system',
            alias: rawAction,
            canonicalAction: action,
            migrationSurface: 'system',
          });
        }
      } catch (error) {
        return textResultWithError(`system failed: ${toErrorMessage(error)}`, true);
      }

      switch (action) {
        case 'read':
          return executeSystemReadAction(config, params);
        case 'restart':
          return executeRestartAction(params, options);
        case 'rebuild':
          return executeRebuildAction(params, options);
      }
    },
  };
}
