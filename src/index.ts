import 'dotenv/config';
import { createComponentLogger } from './shared/logger.js';

const log = createComponentLogger('Main');

function main(): never {
  log.error('This entrypoint is disabled. Use the split runtime or the gateway and agent entrypoints.');
  process.exit(1);
}

main();
