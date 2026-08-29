import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, relative, resolve } from 'node:path';
import type { ResolvedCompanionsFleetConfig } from '../../system/config/companions-config.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import { ensurePersonalFilesLayout } from '../layout.js';

export const COMPANION_LIBRARY_SEED_VERSION = 'companion-library-v4';
export const COMPANION_LIBRARY_MANIFEST_FILE = 'companion-library-manifest.json';
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

interface CompanionLibrarySourceFile {
  path: string;
  sha256: string;
}

interface CompanionLibrarySourceBundle {
  bundleVersion: string;
  sourceManifestSha256: string;
  files: CompanionLibrarySourceFile[];
}

interface CompanionLibrarySourceEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'special';
}

function enumerateSourceEntries(sourceDir: string): CompanionLibrarySourceEntry[] {
  const entries: CompanionLibrarySourceEntry[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const path = relative(sourceDir, absolutePath).replaceAll('\\', '/');
      if (entry.isFile()) entries.push({ path, type: 'file' });
      else if (entry.isDirectory()) {
        entries.push({ path, type: 'directory' });
        visit(absolutePath);
      } else if (entry.isSymbolicLink()) entries.push({ path, type: 'symlink' });
      else entries.push({ path, type: 'special' });
    }
  };
  visit(sourceDir);
  return entries.sort((first, second) => first.path.localeCompare(second.path));
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function loadSourceBundle(sourceDir: string): CompanionLibrarySourceBundle {
  const manifestPath = resolve(sourceDir, COMPANION_LIBRARY_MANIFEST_FILE);
  let rawManifest: string;
  let parsed: unknown;
  try {
    rawManifest = readFileSync(manifestPath, 'utf8');
    parsed = JSON.parse(rawManifest);
  } catch (error) {
    throw new Error(`Invalid Companion Library source manifest ${manifestPath}: ${String(error)}`);
  }
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.bundleVersion !== COMPANION_LIBRARY_SEED_VERSION
    || !Array.isArray(parsed.files)) {
    throw new Error(`Invalid Companion Library source manifest ${manifestPath}: unexpected schema or bundle version`);
  }
  const manifestKeys = Object.keys(parsed).sort();
  if (manifestKeys.join(',') !== 'bundleVersion,files,schemaVersion') {
    throw new Error(`Invalid Companion Library source manifest ${manifestPath}: unknown or missing fields`);
  }

  const files = parsed.files.map((rawFile, index): CompanionLibrarySourceFile => {
    if (!isRecord(rawFile)
      || Object.keys(rawFile).sort().join(',') !== 'path,sha256'
      || typeof rawFile.path !== 'string') {
      throw new Error(`Invalid Companion Library source manifest ${manifestPath}: files[${index}] is malformed`);
    }
    return {
      path: rawFile.path,
      sha256: requireSha256(rawFile.sha256, `Companion Library source manifest files[${index}].sha256`),
    };
  });
  const expectedPaths = [...LIBRARY_SOURCE_FILES].sort();
  const actualPaths = files.map(file => file.path).sort();
  const sourceEntries = enumerateSourceEntries(sourceDir);
  const sourceFiles = sourceEntries
    .filter(entry => entry.type === 'file' && entry.path !== COMPANION_LIBRARY_MANIFEST_FILE)
    .map(entry => entry.path);
  const invalidEntries = sourceEntries.filter(entry => entry.type !== 'file');
  const manifestEntry = sourceEntries.find(entry => entry.path === COMPANION_LIBRARY_MANIFEST_FILE);
  if (new Set(actualPaths).size !== actualPaths.length
    || actualPaths.join('\0') !== expectedPaths.join('\0')
    || sourceFiles.join('\0') !== expectedPaths.join('\0')
    || invalidEntries.length > 0
    || manifestEntry?.type !== 'file') {
    throw new Error(
      `Invalid Companion Library source manifest ${manifestPath}: only manifest-declared regular files are allowed and every bundle file must be declared exactly once`,
    );
  }
  for (const file of files) {
    const sourcePath = resolve(sourceDir, file.path);
    if (!existsSync(sourcePath) || sha256(sourcePath) !== file.sha256) {
      throw new Error(
        `Companion Library source ${sourcePath} does not match its checked-in manifest digest; bump the bundle version and manifest together`,
      );
    }
  }
  return {
    bundleVersion: parsed.bundleVersion,
    sourceManifestSha256: createHash('sha256').update(rawManifest, 'utf8').digest('hex'),
    files,
  };
}

function validateAppliedSeedManifest(path: string, sourceBundle: CompanionLibrarySourceBundle): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid Companion Library seed manifest ${path}: ${String(error)}`);
  }
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.bundleVersion !== sourceBundle.bundleVersion
    || parsed.sourceManifestSha256 !== sourceBundle.sourceManifestSha256
    || !Array.isArray(parsed.files)
    || parsed.files.length !== sourceBundle.files.length) {
    throw new Error(
      `Invalid Companion Library seed manifest ${path}: source bundle changed without a versioned re-application`,
    );
  }
  for (let index = 0; index < sourceBundle.files.length; index += 1) {
    const appliedFile = parsed.files[index];
    const sourceFile = sourceBundle.files[index]!;
    if (!isRecord(appliedFile)
      || appliedFile.path !== sourceFile.path
      || appliedFile.sha256 !== sourceFile.sha256
      || (appliedFile.outcome !== 'seeded' && appliedFile.outcome !== 'preserved')) {
      throw new Error(
        `Invalid Companion Library seed manifest ${path}: applied file hashes do not match the immutable source bundle`,
      );
    }
  }
}

function seedCompanionLibrary(personalWorkspacePath: string, sourceDir: string): void {
  const sourceBundle = loadSourceBundle(sourceDir);
  const stateDir = join(personalWorkspacePath, '.psfn', 'seed-bundles');
  const statePath = join(stateDir, `${COMPANION_LIBRARY_SEED_VERSION}.json`);
  if (existsSync(statePath)) {
    validateAppliedSeedManifest(statePath, sourceBundle);
    return;
  }

  const destinationDir = join(personalWorkspacePath, 'docs', 'companion-library');
  mkdirSync(destinationDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const files = sourceBundle.files.map((sourceFile) => {
    const sourcePath = resolve(sourceDir, sourceFile.path);
    const destinationPath = join(destinationDir, basename(sourceFile.path));
    let outcome: 'seeded' | 'preserved' = 'seeded';
    try {
      copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      outcome = 'preserved';
    }
    return { path: sourceFile.path, sha256: sourceFile.sha256, outcome };
  });

  writeJsonAtomic(statePath, {
    schemaVersion: 1,
    bundleVersion: sourceBundle.bundleVersion,
    sourceManifestSha256: sourceBundle.sourceManifestSha256,
    appliedAt: new Date().toISOString(),
    destination: 'docs/companion-library',
    overwritePolicy: 'never',
    files,
  });
}

function ensureSharedWorkspace(sharedWorkspacePath: string): void {
  for (const relativePath of [
    'artifacts',
    'reviews',
    'cogsec-decisions',
    'provenance/events',
    'transactions',
    '.locks',
  ]) {
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
  const sourceDir = options.companionLibrarySourceDir ?? resolve('resources/companion-library');
  for (const companion of fleet.companions) {
    ensurePersonalFilesLayout(companion.personalWorkspacePath);
    seedCompanionLibrary(companion.personalWorkspacePath, sourceDir);
  }
  ensureSharedWorkspace(fleet.sharedWorkspacePath);
}
