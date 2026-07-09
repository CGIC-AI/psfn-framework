import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/system/config/load-config.js';
import { verifyStartupOwnerFiles } from '../src/system/config/startup-owner-files.js';

const OWNER_FILE_SEEDS = [
  ['settings.seed.json', 'settings.json'],
  ['models.seed.json', 'models.json'],
  ['providers.seed.json', 'providers.json'],
  ['trust-policy.seed.json', 'trust-policy.json'],
  ['scheduler.seed.json', 'scheduler.json'],
  ['capability-tier.seed.json', 'capability-tier.json'],
  ['charge-policy.seed.json', 'charge-policy.json'],
  ['backup.seed.json', 'backup.json'],
  ['skills.seed.json', 'skills.json'],
  ['intake-policy.seed.json', 'intake-policy.json'],
] as const;

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadDotenvPreservingExisting(filePath: string): void {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const separatorIndex = withoutExport.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = withoutExport.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(withoutExport.slice(separatorIndex + 1));
  }
}

function seedVerificationEnvDefault(key: string, value: string): void {
  if (process.env[key]?.trim()) return;
  process.env[key] = value;
}

function hasExplicitRuntimeDataRoot(): boolean {
  return Boolean(
    process.env.DATA_DIR?.trim()
    || process.env.SYSTEM_DATA_DIR?.trim()
    || process.env.COMPANION_DATA_DIR?.trim()
    || process.env.PSFN_RUNTIME_ROOT?.trim(),
  );
}

function createOwnerFileFixtureDataDir(seedDir: string): string {
  mkdirSync(resolve('tmp'), { recursive: true });
  const dataDir = mkdtempSync(join(resolve('tmp'), 'verify-startup-owner-files-'));
  for (const [seedFile, ownerFile] of OWNER_FILE_SEEDS) {
    copyFileSync(join(seedDir, seedFile), join(dataDir, ownerFile));
  }
  return dataDir;
}

loadDotenvPreservingExisting(process.env.PSFN_DOTENV_FILE?.trim() || '.env');
seedVerificationEnvDefault('COMPANION_ID', 'verification-companion');
seedVerificationEnvDefault('POSTGRES_DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:5432/psfn_verify');

const seedDir = process.env.CONFIG_DIR?.trim() || './config';
const fixtureDataDir = hasExplicitRuntimeDataRoot()
  ? undefined
  : createOwnerFileFixtureDataDir(seedDir);

try {
  if (fixtureDataDir) {
    process.env.DATA_DIR = fixtureDataDir;
  }

  const config = loadConfig();
  const result = verifyStartupOwnerFiles({
    dataDir: config.dataDir,
    seedDir,
    defaultContextWindow: config.defaultContextWindow,
  });

  if (!result.ok) {
    console.error('Startup owner-file validation failed:');
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
  } else {
    console.log('Startup owner-file validation passed.');
  }
} finally {
  if (fixtureDataDir) {
    rmSync(fixtureDataDir, { recursive: true, force: true });
  }
}
