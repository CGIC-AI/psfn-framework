import 'dotenv/config';
import { ensureActiveTimezone } from './time/active-timezone.js';
import { loadConfig } from './types.js';
import { SubstrateRuntime } from './runtime.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('Main');

async function main(): Promise<void> {
  ensureActiveTimezone();
  const config = loadConfig();
  const runtime = new SubstrateRuntime(config);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    await runtime.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await runtime.init();
    await runtime.start();
  } catch (error) {
    log.error('Fatal error', { error: String(error) });
    await runtime.stop().catch(() => {});
    process.exit(1);
  }
}

main();
