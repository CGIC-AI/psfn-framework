// ── Lifecycle tools ──
// self_restart and self_rebuild tools for Purrsephone to trigger her own restarts.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { LifecycleNotifier } from '../lifecycle/notifications.js';
import { createComponentLogger } from '../logger.js';
import type { CapabilityTier } from '../types.js';
import type { LifecycleRestartSafeguard } from '../capabilities/safeguards.js';

const log = createComponentLogger('LifecycleTools');

interface LifecycleToolOptions {
  restartSafeguard?: LifecycleRestartSafeguard;
  getCapabilityTier?: () => CapabilityTier;
}

function blockResult(message: string): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{ type: 'text', text: message }] satisfies TextContent[],
    details: { isError: true },
  };
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
      const reason = params.reason?.trim();
      if (!reason) {
        return blockResult('Restart blocked: reason is required.');
      }
      const tier = options.getCapabilityTier?.() ?? 'autonomous';
      if (options.restartSafeguard) {
        const decision = options.restartSafeguard.evaluate({
          toolName: 'self_restart',
          reason,
          tier,
        });
        if (!decision.allowed) {
          return blockResult(decision.reason);
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
      const reason = params.reason?.trim();
      if (!reason) {
        return blockResult('Rebuild blocked: reason is required.');
      }
      const tier = options.getCapabilityTier?.() ?? 'autonomous';
      if (options.restartSafeguard) {
        const decision = options.restartSafeguard.evaluate({
          toolName: 'self_rebuild',
          reason,
          tier,
        });
        if (!decision.allowed) {
          return blockResult(decision.reason);
        }
      }
      const fullReason = `rebuild: ${reason}`;

      log.info('Self-rebuild requested', { reason, tier });

      // Send pre-restart notification
      await notifier.notifyPreRestart(fullReason);

      // Schedule build + shutdown after tool result returns
      setImmediate(async () => {
        let buildSucceeded = false;
        try {
          const { execSync } = await import('node:child_process');
          log.info('Running npm run build...');
          execSync('npm run build', {
            cwd: process.cwd(),
            stdio: 'pipe',
            timeout: 120_000,
          });
          buildSucceeded = true;
          log.info('Build complete, shutting down...');
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          log.error('Build failed; aborting restart', { error: errorText });
          await notifier.notifyShutdown(`rebuild failed: ${errorText.slice(0, 160)}`);
          return;
        }

        if (buildSucceeded) {
          try {
            await stopFn();
          } catch (err) {
            log.error('Error during shutdown', { error: String(err) });
          }
          process.exit(0);
        }
      });

      return {
        content: [{ type: 'text', text: 'Rebuild initiated. Building, then restarting...' }] satisfies TextContent[],
        details: {},
      };
    },
  };
}
