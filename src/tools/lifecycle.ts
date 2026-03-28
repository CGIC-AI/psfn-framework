// ── Lifecycle tools ──
// self_restart and self_rebuild tools for the companion to trigger its own restarts.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { LifecycleNotifier } from '../system/lifecycle/notifications.js';
import { createComponentLogger } from '../shared/logger.js';
import type { CapabilityTier } from '../system/config/runtime-config-contracts.js';
import type { LifecycleRestartSafeguard } from '../system/capabilities/safeguards.js';
import { textResultWithError } from './results.js';

const log = createComponentLogger('LifecycleTools');

interface LifecycleToolOptions {
  restartSafeguard?: LifecycleRestartSafeguard;
  getCapabilityTier?: () => CapabilityTier;
  runRestartCommand?: () => Promise<void>;
  runBuildCommand?: () => Promise<void>;
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
