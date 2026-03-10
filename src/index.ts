import 'dotenv/config';
import { createComponentLogger } from './logger.js';
import { RUNTIME_MODE, resolveRuntimeModeContract } from './lifecycle/runtime-mode.js';

const log = createComponentLogger('Main');

function main(): never {
  try {
    resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.SINGLE,
      runtimeModeEnv: process.env.PSFN_RUNTIME_MODE,
      restartCommandEnv: process.env.LIFECYCLE_RESTART_COMMAND,
    });
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  log.error('Monolithic runtime mode is unavailable.');
  process.exit(1);
}

main();
