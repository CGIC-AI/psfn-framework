import 'dotenv/config';
import { ensureActiveTimezone } from '../../shared/time/active-timezone.js';
import { createComponentLogger } from '../../shared/logger.js';
import { loadConfig } from '../../system/config/load-config.js';
import { hydrateJsonBackedRuntimeConfig } from '../../system/config/runtime-config.js';
import { parseOptionalPositiveIntEnv } from '../../shared/utils/env.js';
import { createSignalShutdownHandler } from '../startup/support/signal-shutdown.js';
import { runShutdownSequence } from '../startup/support/shutdown-helpers.js';
import { isExplicitTrue } from '../startup/support/env-parsing.js';
import {
  resolveAdminTransportSocketPath,
} from '../../operator/garden/transport-paths.js';
import { GardenOperatorSurface } from '../../operator/garden/operator-surface.js';

const log = createComponentLogger('OperatorSurface');
const DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 15_000;

ensureActiveTimezone();

async function main(): Promise<void> {
  const config = hydrateJsonBackedRuntimeConfig(loadConfig());
  const adminPort = parseOptionalPositiveIntEnv(process.env.ADMIN_PORT);
  if (!adminPort) {
    throw new Error('ADMIN_PORT is required for the operator Garden surface');
  }

  const surface = new GardenOperatorSurface({
    port: adminPort,
    host: process.env.ADMIN_HOST || undefined,
    token: process.env.ADMIN_TOKEN || undefined,
    allowInsecureWithoutToken: isExplicitTrue(process.env.ADMIN_ALLOW_INSECURE),
    config,
    transportSocketPath: resolveAdminTransportSocketPath(process.env),
  });
  await surface.init();
  await surface.start();

  const stop = async (): Promise<void> => {
    await runShutdownSequence([
      { step: 'stop Garden operator surface', action: () => surface.stop() },
    ], log);
    log.info('Stopped');
  };

  const shutdown = createSignalShutdownHandler({
    logger: log,
    runGracefulShutdown: stop,
    exit: (code) => { process.exit(code); },
    forceExitTimeoutMs: DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT').catch((error) => {
      log.error('Unhandled SIGINT shutdown error', { error: String(error) });
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').catch((error) => {
      log.error('Unhandled SIGTERM shutdown error', { error: String(error) });
      process.exit(1);
    });
  });
}

main().catch((error) => {
  log.error('Fatal error', { error: String(error) });
  process.exit(1);
});
