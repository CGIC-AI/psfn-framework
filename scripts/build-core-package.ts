#!/usr/bin/env tsx

/**
 * Builds the standalone companion core package (`packages/core/`):
 * 1. Bundles ESM entrypoints + `.d.ts` + session worker scripts via tsup.
 * 2. Syncs the 9 canonical `config/*.seed.json` files into `packages/core/config/`.
 * 3. Copies the repository `LICENSE` into `packages/core/LICENSE`.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { COMPANION_SEED_FILES } from '../packages/core/src/seeds.js';

const ROOT_DIR = process.cwd();
const PACKAGE_DIR = resolve(ROOT_DIR, 'packages/core');
const PACKAGE_CONFIG_DIR = join(PACKAGE_DIR, 'config');
const ROOT_CONFIG_DIR = resolve(ROOT_DIR, 'config');

export function buildCorePackage(): void {
  execFileSync(
    process.execPath,
    [
      '--max-old-space-size=8192',
      resolve(ROOT_DIR, 'node_modules/tsup/dist/cli-default.js'),
      '--config',
      resolve(PACKAGE_DIR, 'tsup.config.ts'),
    ],
    {
      cwd: ROOT_DIR,
      stdio: 'inherit',
    },
  );

  rmSync(PACKAGE_CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(PACKAGE_CONFIG_DIR, { recursive: true });
  for (const seedFile of COMPANION_SEED_FILES) {
    copyFileSync(join(ROOT_CONFIG_DIR, seedFile), join(PACKAGE_CONFIG_DIR, seedFile));
  }
  copyFileSync(resolve(ROOT_DIR, 'LICENSE'), join(PACKAGE_DIR, 'LICENSE'));
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  buildCorePackage();
}
