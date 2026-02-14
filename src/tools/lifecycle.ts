// ── Lifecycle tools ──
// self_restart and self_rebuild tools for Purrsephone to trigger her own restarts.

import type { SubstrateTool } from '../types.js';
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
): SubstrateTool {
  return {
    name: 'self_restart',
    description:
      'Restart yourself. Sends a "brb" message to Discord, cleanly shuts down, ' +
      'and exits. Your process supervisor will restart you automatically. ' +
      'Use when you need a fresh start or after configuration changes.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional reason for restarting (shown in Discord notification)',
        },
      },
      required: [],
    },
    execute: async (input) => {
      const reason = (input.reason as string | undefined) ?? undefined;

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

      return { content: 'Restart initiated. Sending notification and shutting down...' };
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
): SubstrateTool {
  return {
    name: 'self_rebuild',
    description:
      'Rebuild and restart yourself. Runs `npm run build` first, then restarts. ' +
      'Use after code changes that need recompilation.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional reason for rebuilding (shown in Discord notification)',
        },
      },
      required: [],
    },
    execute: async (input) => {
      const reason = (input.reason as string | undefined) ?? undefined;
      const fullReason = reason ? `rebuild: ${reason}` : 'rebuild';

      log.info('Self-rebuild requested', { reason });

      // Send pre-restart notification
      await notifier.notifyPreRestart(fullReason);

      // Schedule build + shutdown after tool result returns
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
          log.error('Build failed', { error: String(err) });
          // Still restart even if build fails — supervisor can sort it out
        }

        try {
          await stopFn();
        } catch (err) {
          log.error('Error during shutdown', { error: String(err) });
        }
        process.exit(0);
      });

      return { content: 'Rebuild initiated. Building, then restarting...' };
    },
  };
}
