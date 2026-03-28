import 'dotenv/config';
import { createComponentLogger } from './logger.js';
import { RUNTIME_MODE } from './lifecycle/runtime-mode.js';
import { resolveStartupLifecycleBundle } from './runtime/startup-preflight.js';

const log = createComponentLogger('Main');

function main(): never {
  try {
    resolveStartupLifecycleBundle({
      entrypoint: RUNTIME_MODE.SINGLE,
      env: process.env,
    });
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  log.error('Monolithic runtime mode is unavailable.');
  process.exit(1);
}

main();
