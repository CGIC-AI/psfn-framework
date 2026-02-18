// ── Lifecycle tools ──
// self_restart and self_rebuild tools for PSFN to trigger her own restarts.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { LifecycleNotifier } from '../lifecycle/notifications.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('LifecycleTools');

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
): AgentTool<any> {
  return {
    name: 'self_restart',
    description:
      'Restart yourself. Sends a "brb" message to Discord, cleanly shuts down, ' +
      'and exits. Your process supervisor will restart you automatically. ' +
      'Use when you need a fresh start or after configuration changes.',
    label: 'self_restart',
    parameters: Type.Object({
      reason: Type.Optional(
        Type.String({ description: 'Optional reason for restarting (shown in Discord notification)' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { reason?: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const reason = params.reason ?? undefined;

      log.info('Self-restart requested', { reason });

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
): AgentTool<any> {
  return {
    name: 'self_rebuild',
    description:
      'Rebuild and restart yourself. Runs `npm run build` first, then restarts. ' +
      'Use after code changes that need recompilation.',
    label: 'self_rebuild',
    parameters: Type.Object({
      reason: Type.Optional(
        Type.String({ description: 'Optional reason for rebuilding (shown in Discord notification)' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { reason?: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const reason = params.reason ?? undefined;
      const fullReason = reason ? `rebuild: ${reason}` : 'rebuild';

      log.info('Self-rebuild requested', { reason });

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
