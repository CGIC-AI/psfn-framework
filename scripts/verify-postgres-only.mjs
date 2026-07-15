import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const RETIRED_PACKAGE_NAMES = [
  ['better', 'sqlite3'].join('-'),
  ['sqlite', 'vec'].join('-'),
  ['@types', ['better', 'sqlite3'].join('-')].join('/'),
];
const RETIRED_TOKEN = /sqlite|better-sqlite3|sqlite-vec/iu;
const RELATIVE_IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\()\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gmu;
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.env',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const SCAN_TARGETS = [
  'src',
  'scripts',
  'config',
  'README.md',
  'docs/memory.md',
  'docs/architecture.md',
  'docs/operations.md',
  'docs/development-status.md',
  'docs/CODEBASE_MAP.md',
  'docs/specifications.md',
  'docs/PSFN_PROJECT_CHARTER.md',
  'docs/context-envelope.md',
  'deploy/helm/psfn/README.md',
];
const RETIRED_IMPLEMENTATION_PATHS = [
  'src/app/maintenance/sqlite-to-postgres-memory-migration.ts',
  'src/boundary/gateway/audit.ts',
  'src/core/contacts/sqlite-adapter.ts',
  'src/core/intention/sqlite-adapters.ts',
  'src/core/intention/sqlite-stores',
  'src/faculties/memory/episodic/store-rows.ts',
  'src/faculties/memory/episodic/store.ts',
  'src/faculties/memory/store',
  'src/faculties/memory/store.test.ts',
  'src/faculties/memory/store.ts',
  'src/persistence/backups/startup-checks.ts',
  'src/persistence/reflections/sqlite-mirror.ts',
  'src/persistence/sessions/sqlite-adapters.ts',
  'src/persistence/sessions/transcript-projection.ts',
  'src/persistence/sqlite-companion-store.ts',
  'src/persistence/sqlite-utils.ts',
];

const TEXT_REFERENCE_ALLOWLIST = [
  {
    path: 'README.md',
    contains: 'SQLite runtime implementations, readers, and packages have been removed.',
    classification: 'cutover-contract',
    reason: 'The source-of-truth overview states the completed removal explicitly.',
  },
  {
    path: 'README.md',
    contains: 'no SQLite runtime or migration-reader dependency',
    classification: 'cutover-contract',
    reason: 'The technology table names the absence of the retired dependency.',
  },
  {
    path: 'docs/memory.md',
    contains: 'SQLite and sqlite-vec implementations, dependencies, and migration readers are removed.',
    classification: 'cutover-contract',
    reason: 'The memory contract distinguishes active stores from removed implementations.',
  },
  {
    path: 'docs/architecture.md',
    contains: 'SQLite-backed stores and migration readers are removed',
    classification: 'cutover-contract',
    reason: 'Architecture documents the absence of the old adapter family.',
  },
  {
    path: 'docs/architecture.md',
    contains: 'No SQLite implementation or reader remains behind the domain ports.',
    classification: 'cutover-contract',
    reason: 'Architecture makes the port boundary unambiguous.',
  },
  {
    path: 'docs/operations.md',
    contains: 'SQLite-backed stores, migration readers, and native packages are removed',
    classification: 'cutover-contract',
    reason: 'Operations records the supported backend boundary.',
  },
  {
    path: 'docs/development-status.md',
    contains: 'original SQLite-centered prototype shape: SQLite implementations and packages are removed',
    classification: 'cutover-history',
    reason: 'Current status records the completed prototype-to-Postgres transition.',
  },
  {
    path: 'docs/development-status.md',
    contains: '| SQLite retirement | SQLite implementations, migration readers, native packages, and dead adapter tests are removed',
    classification: 'cutover-history',
    reason: 'The shipped milestone states exactly what was retired.',
  },
  {
    path: 'docs/CODEBASE_MAP.md',
    contains: 'SQLite (`better-sqlite3`/`sqlite-vec`) implementations and packages are removed.',
    classification: 'cutover-contract',
    reason: 'The codebase map prevents agents from looking for deleted adapters.',
  },
  {
    path: 'docs/specifications.md',
    contains: 'opaque pre-cutover SQLite database placement',
    classification: 'legacy-artifact-contract',
    reason: 'The live alpha boundary permits opaque layout preservation without a reader.',
  },
  {
    path: 'docs/specifications.md',
    contains: 'do not open them through a SQLite reader',
    classification: 'legacy-artifact-contract',
    reason: 'The live alpha boundary explicitly denies an implementation exception.',
  },
  {
    path: 'docs/PSFN_PROJECT_CHARTER.md',
    contains: 'SQLite implementations, dependencies, readers, and adapter fixtures are removed.',
    classification: 'cutover-contract',
    reason: 'The project charter states the final persistence law.',
  },
  {
    path: 'scripts/recovery/psfn-ext4-recovery.sh',
    contains: 'SQLite format 3|l2_memories|contact_profiles|session_messages_index',
    classification: 'legacy-artifact-signature',
    reason: 'Filesystem recovery intentionally recognizes old on-disk artifacts without opening them.',
  },
  {
    path: 'scripts/verify-backup-restore.ts',
    contains: 'SQLite backup verification is retired; current backups must use Postgres dump archives',
    classification: 'fail-closed-regression',
    reason: 'The verifier rejects an obsolete backup mode with an actionable error.',
  },
  {
    path: 'src/app/maintenance/transcript-projection-repair.test.ts',
    contains: 'config backend is sqlite and leaves legacy sqlite search absent',
    classification: 'fail-closed-regression',
    reason: 'The repair command proves a stale backend value cannot revive the retired projection.',
  },
  {
    path: 'src/app/maintenance/transcript-projection-repair.test.ts',
    contains: "persistenceBackend: 'sqlite'",
    classification: 'fail-closed-regression',
    reason: 'The fixture supplies the unsupported value that the repair path must ignore or reject.',
  },
  {
    path: 'src/app/maintenance/transcript-projection-repair.test.ts',
    contains: "'session-search.sqlite'",
    classification: 'fail-closed-regression',
    reason: 'The test asserts that repair never creates the retired projection artifact.',
  },
  {
    path: 'src/app/agent/core-runtime.test.ts',
    contains: 'when sqlite db is absent',
    classification: 'fail-closed-regression',
    reason: 'The test proves episodic wiring no longer depends on a retired database handle.',
  },
  {
    path: 'src/app/agent/core-runtime.test.ts',
    contains: 'instead of using sqlite fallbacks',
    classification: 'fail-closed-regression',
    reason: 'The test names the fallback behavior that must remain impossible.',
  },
  {
    path: 'src/app/startup/composition/session-composition.test.ts',
    contains: 'does not create the legacy sqlite search projection',
    classification: 'fail-closed-regression',
    reason: 'Composition must not recreate the retired projection.',
  },
  {
    path: 'src/app/startup/composition/session-composition.test.ts',
    contains: "'session-search.sqlite'",
    classification: 'fail-closed-regression',
    reason: 'The test asserts the retired projection file is absent.',
  },
  {
    path: 'src/app/startup/composition/session-composition.test.ts',
    contains: 'without creating a legacy sqlite database',
    classification: 'fail-closed-regression',
    reason: 'The memory composition regression proves Postgres startup creates no alternate database.',
  },
  {
    path: 'src/persistence/cutover.test.ts',
    contains: "writeText(join(dirs.legacySharedDataDir, 'companion.db'), 'sqlite');",
    classification: 'legacy-artifact-fixture',
    reason: 'The two-root layout cutover preserves an opaque legacy database file byte-for-byte.',
  },
  {
    path: 'src/persistence/cutover.test.ts',
    contains: "writeText(join(dirs.legacySharedDataDir, 'companion.db'), 'sqlite-main');",
    classification: 'legacy-artifact-fixture',
    reason: 'The collision fixture distinguishes the legacy main file from its sidecar.',
  },
  {
    path: 'src/persistence/cutover.test.ts',
    contains: "writeText(join(dirs.legacySharedDataDir, 'companion.db-wal'), 'sqlite-wal');",
    classification: 'legacy-artifact-fixture',
    reason: 'The collision fixture preserves a legacy sidecar as opaque data.',
  },
  {
    path: 'src/persistence/runtime-factory.test.ts',
    contains: "persistenceBackend: 'sqlite' as never",
    classification: 'fail-closed-regression',
    reason: 'The runtime factory test supplies an unsupported backend and requires rejection.',
  },
  {
    path: 'src/persistence/postgres/parity-matrix.test.ts',
    contains: 'not.toMatch(/sqlite|better-sqlite|sqlite-vec/u)',
    classification: 'negative-contract-regression',
    reason: 'The parity matrix test rejects retired implementation terminology from its data.',
  },
  {
    path: 'src/persistence/postgres/parity-matrix.test.ts',
    contains: "not.toHaveProperty('sqliteSourceArtifacts')",
    classification: 'negative-contract-regression',
    reason: 'The test prevents the deleted migration-era field from returning.',
  },
  {
    path: 'src/operator/garden/api-routes-postgres-memory-cutover-smoke.test.ts',
    contains: ".not.toContain('sqlite')",
    classification: 'fail-closed-regression',
    reason: 'Garden settings must not expose the retired backend.',
  },
  {
    path: 'src/operator/garden/api-routes-postgres-memory-cutover-smoke.test.ts',
    contains: 'sqliteRuntimeFields',
    classification: 'fail-closed-regression',
    reason: 'The local variable names the forbidden schema fields under test.',
  },
  {
    path: 'src/operator/garden/api-routes-postgres-memory-cutover-smoke.test.ts',
    contains: "enumValues?.includes('sqlite')",
    classification: 'fail-closed-regression',
    reason: 'The test searches settings enums for the unsupported value.',
  },
  {
    path: 'src/operator/garden/api-routes-postgres-memory-cutover-smoke.test.ts',
    contains: 'SQLite must not be exposed as normal Garden runtime config',
    classification: 'fail-closed-regression',
    reason: 'The assertion message states the security boundary.',
  },
];

function parseRoot(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex < 0) return DEFAULT_ROOT;
  const value = argv[rootIndex + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--root requires a repository path');
  }
  return resolve(value);
}

function normalizePath(root, path) {
  return relative(root, path).split('\\').join('/');
}

function collectTextFiles(path, files) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => (
      left.name.localeCompare(right.name)
    ))) {
      collectTextFiles(join(path, entry.name), files);
    }
    return;
  }
  if (TEXT_EXTENSIONS.has(extname(path).toLowerCase())) files.push(path);
}

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`${label} is unreadable or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function verifyPackages(root, errors) {
  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) {
    errors.push('package.json is missing');
    return;
  }
  const packageJson = readJson(packagePath, 'package.json', errors);
  if (packageJson) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = packageJson[section] ?? {};
      for (const name of RETIRED_PACKAGE_NAMES) {
        if (Object.prototype.hasOwnProperty.call(dependencies, name)) {
          errors.push(`forbidden package ${name} remains in package.json ${section}`);
        }
      }
    }
  }

  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath)) {
    errors.push('package-lock.json is missing');
    return;
  }
  const lock = readJson(lockPath, 'package-lock.json', errors);
  if (!lock) return;
  const serialized = JSON.stringify(lock).toLowerCase();
  for (const name of RETIRED_PACKAGE_NAMES) {
    if (serialized.includes(name)) {
      errors.push(`forbidden package ${name} remains in package-lock.json`);
    }
  }
}

function verifyRetiredPaths(root, errors) {
  for (const retiredPath of RETIRED_IMPLEMENTATION_PATHS) {
    const path = join(root, retiredPath);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isDirectory() && !directoryContainsTrackedContent(path)) continue;
    errors.push(`retired implementation path exists: ${retiredPath}`);
  }
}

function directoryContainsTrackedContent(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.isFile()) return true;
    if (entry.isDirectory() && directoryContainsTrackedContent(join(path, entry.name))) return true;
  }
  return false;
}

function verifyTextReferences(root, errors) {
  const files = [];
  for (const target of SCAN_TARGETS) {
    const path = join(root, target);
    if (existsSync(path)) collectTextFiles(path, files);
  }
  files.sort((left, right) => left.localeCompare(right));

  const allowlistByPath = new Map();
  for (const [index, entry] of TEXT_REFERENCE_ALLOWLIST.entries()) {
    const entries = allowlistByPath.get(entry.path) ?? [];
    entries.push({ ...entry, index });
    allowlistByPath.set(entry.path, entries);
  }
  const usedAllowlistEntries = new Set();
  const retiredFiles = new Set(
    RETIRED_IMPLEMENTATION_PATHS
      .filter(path => extname(path) !== '')
      .map(path => path.replace(/\.[^.]+$/u, '')),
  );
  const retiredDirectories = RETIRED_IMPLEMENTATION_PATHS
    .filter(path => extname(path) === '');

  for (const path of files) {
    if (resolve(path) === resolve(SCRIPT_PATH)) continue;
    const repositoryPath = normalizePath(root, path);
    const allowed = allowlistByPath.get(repositoryPath) ?? [];
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const resolvedImport = normalizePath(root, resolve(dirname(path), specifier))
        .replace(/\.[^.]+$/u, '');
      if (
        retiredFiles.has(resolvedImport)
        || retiredDirectories.some(directory => (
          resolvedImport === directory || resolvedImport.startsWith(`${directory}/`)
        ))
      ) {
        errors.push(`retired implementation import: ${repositoryPath}: ${specifier}`);
      }
    }

    const lines = source.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (!RETIRED_TOKEN.test(line)) continue;
      const matches = allowed.filter(entry => line.includes(entry.contains));
      if (matches.length > 0) {
        for (const match of matches) usedAllowlistEntries.add(match.index);
        const unclassifiedRemainder = matches.reduce(
          (remainder, match) => remainder.replace(match.contains, ''),
          line,
        );
        if (RETIRED_TOKEN.test(unclassifiedRemainder)) {
          errors.push(`unclassified retired-backend reference: ${repositoryPath}:${index + 1}: ${line.trim()}`);
        }
        continue;
      }
      errors.push(`unclassified retired-backend reference: ${repositoryPath}:${index + 1}: ${line.trim()}`);
    }
  }

  for (const [index, entry] of TEXT_REFERENCE_ALLOWLIST.entries()) {
    if (!existsSync(join(root, entry.path))) continue;
    if (!usedAllowlistEntries.has(index)) {
      errors.push(`stale text-reference allowlist entry: ${entry.path}: ${entry.contains}`);
    }
  }
}

export function verifyPostgresOnly(root) {
  const errors = [];
  verifyPackages(root, errors);
  verifyRetiredPaths(root, errors);
  verifyTextReferences(root, errors);
  return errors.sort((left, right) => left.localeCompare(right));
}

function main() {
  const root = parseRoot(process.argv.slice(2));
  const errors = verifyPostgresOnly(root);
  if (errors.length > 0) {
    console.error('[verify-postgres-only] failed');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('[verify-postgres-only] passed');
}

if (resolve(process.argv[1] ?? '') === resolve(SCRIPT_PATH)) {
  main();
}
