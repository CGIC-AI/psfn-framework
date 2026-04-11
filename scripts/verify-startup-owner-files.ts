import 'dotenv/config';
import { loadConfig } from '../src/system/config/load-config.js';
import { verifyStartupOwnerFiles } from '../src/system/config/startup-owner-files.js';

const config = loadConfig();
const result = verifyStartupOwnerFiles({
  dataDir: config.dataDir,
  seedDir: process.env.CONFIG_DIR,
  defaultContextWindow: config.defaultContextWindow,
});

if (!result.ok) {
  console.error('Startup owner-file validation failed:');
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Startup owner-file validation passed.');
