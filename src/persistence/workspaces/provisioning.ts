import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import type { ResolvedCompanionsFleetConfig } from '../../system/config/companions-config.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import { ensurePersonalFilesLayout } from '../layout.js';

export const COMPANION_LIBRARY_SEED_VERSION = 'companion-library-v1';
export const SHARED_WORKSPACE_POLICY_VERSION = 1;

export const SHARED_WORKSPACE_POLICY = Object.freeze({
  version: SHARED_WORKSPACE_POLICY_VERSION,
  companionAccess: 'read_only',
  writes: 'operator_reviewed_only',
  requireIndependentReviewer: true,
  requireCogSecApproval: true,
  promptAutoLoad: false,
  wikiAutoLoad: false,
  memoryAutoLoad: false,
  executableAutoLoad: false,
});

const LIBRARY_SOURCE_FILES = [
  'welcome.md',
  'privacy-boundary-reference.md',
] as const;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validateAppliedSeedManifest(path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid Companion Library seed manifest ${path}: ${String(error)}`);
  }
  if (!isRecord(parsed) || parsed.version !== COMPANION_LIBRARY_SEED_VERSION) {
    throw new Error(`Invalid Companion Library seed manifest ${path}: unexpected version`);
  }
}

function seedCompanionLibrary(personalWorkspacePath: string, sourceDir: string): void {
  const stateDir = join(personalWorkspacePath, '.psfn', 'seed-bundles');
  const statePath = join(stateDir, `${COMPANION_LIBRARY_SEED_VERSION}.json`);
  if (existsSync(statePath)) {
    validateAppliedSeedManifest(statePath);
    return;
  }

  const destinationDir = join(personalWorkspacePath, 'docs', 'companion-library');
  mkdirSync(destinationDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const files = LIBRARY_SOURCE_FILES.map((name) => {
    const sourcePath = resolve(sourceDir, name);
    if (!existsSync(sourcePath)) {
      throw new Error(`Companion Library seed source is missing: ${sourcePath}`);
    }
    const destinationPath = join(destinationDir, basename(name));
    let outcome: 'seeded' | 'preserved' = 'seeded';
    try {
      copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      outcome = 'preserved';
    }
    return { name, sha256: sha256(sourcePath), outcome };
  });

  writeJsonAtomic(statePath, {
    version: COMPANION_LIBRARY_SEED_VERSION,
    appliedAt: new Date().toISOString(),
    destination: 'docs/companion-library',
    overwritePolicy: 'never',
    files,
  });
}

function ensureSharedWorkspace(sharedWorkspacePath: string): void {
  for (const relativePath of ['artifacts', 'reviews', 'provenance', '.locks']) {
    mkdirSync(join(sharedWorkspacePath, relativePath), { recursive: true });
  }
  const policyPath = join(sharedWorkspacePath, 'policy.json');
  const expected = `${JSON.stringify(SHARED_WORKSPACE_POLICY, null, 2)}\n`;
  if (!existsSync(policyPath)) {
    writeFileSync(policyPath, expected, { encoding: 'utf8', flag: 'wx' });
    return;
  }
  if (readFileSync(policyPath, 'utf8') !== expected) {
    throw new Error(
      `Shared Companion Workspace policy at ${policyPath} is malformed or differs from the runtime contract`,
    );
  }
}

/** Provision all fleet roots before any companion or channel surface starts. */
export function provisionFleetWorkspaces(
  fleet: ResolvedCompanionsFleetConfig,
  options: { companionLibrarySourceDir?: string } = {},
): void {
  const sourceDir = options.companionLibrarySourceDir ?? resolve('companion_docs');
  for (const companion of fleet.companions) {
    ensurePersonalFilesLayout(companion.personalWorkspacePath);
    seedCompanionLibrary(companion.personalWorkspacePath, sourceDir);
  }
  ensureSharedWorkspace(fleet.sharedWorkspacePath);
}
