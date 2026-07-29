import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Agent secrets import boundary (psfn-framework-owffl.4).
//
// The agent process must never hold secrets: no dotenv, no credential vault,
// no env-secret loader may enter its transitive import graph. The invariant
// held by convention only — a future `import { loadDotenv }` in any module the
// agent reaches would compile, pass every test, and silently move secrets
// across the gateway/agent trust boundary. This walks the real static import
// closure of src/app/agent/** and fails closed on the forbidden set.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const srcRoot = resolve(repoRoot, 'src');
const agentRoot = resolve(srcRoot, 'app/agent');

/** Bare package specifiers the agent closure must never import. */
const FORBIDDEN_PACKAGES = new Set(['dotenv']);

/** Repo-relative module files the agent closure must never reach. */
const FORBIDDEN_MODULES = new Set([
  'src/shared/utils/load-dotenv.ts',
  'src/boundary/custody/credential-vault.ts',
]);

/**
 * Existing violations under active burn-down. Each entry names the tracking
 * bead; the fix removes the entry, and a stale entry (violation gone, entry
 * kept) fails the test so the baseline can only shrink.
 */
const KNOWN_VIOLATIONS = new Map<string, string>([
  // Value import of resolveInlineOrEnvCredential in the shared TTS connector
  // index pulls the vault into the agent closure via startup-guards ->
  // bootstrap-helpers -> voice-provider-runtime -> plugin-eligibility.
  ['src/boundary/custody/credential-vault.ts', 'psfn-framework-mp1pf'],
]);

const IMPORT_PATTERN = /(?:import|export)\s+[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

function listAgentEntryFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listAgentEntryFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    join(base, 'index.ts'),
    base,
  ];
  for (const candidate of candidates) {
    if (candidate.endsWith('.ts') && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match.slice(1).find((group): group is string => typeof group === 'string');
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

interface ClosureResult {
  files: Set<string>;
  packages: Map<string, string>;
  parents: Map<string, string>;
}

function walkImportClosure(entryFiles: string[]): ClosureResult {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const parents = new Map<string, string>();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf-8');
    for (const specifier of extractSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativeImport(file, specifier);
        if (resolved && !files.has(resolved)) {
          parents.set(resolved, file);
          queue.push(resolved);
        }
      } else if (!specifier.startsWith('node:')) {
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (!packages.has(packageName)) packages.set(packageName, file);
      }
    }
  }
  return { files, packages, parents };
}

function importChain(parents: Map<string, string>, file: string): string {
  const chain = [relative(repoRoot, file)];
  let current = file;
  while (parents.has(current)) {
    current = parents.get(current)!;
    chain.unshift(relative(repoRoot, current));
  }
  return chain.join('\n  -> ');
}

describe('agent secrets import boundary (owffl.4)', () => {
  const closure = walkImportClosure(listAgentEntryFiles(agentRoot));

  it('never imports a forbidden secret-bearing package', () => {
    for (const [packageName, importer] of closure.packages) {
      expect(
        FORBIDDEN_PACKAGES.has(packageName),
        `agent closure imports forbidden package "${packageName}" via ${relative(repoRoot, importer)}`,
      ).toBe(false);
    }
  });

  it('never transitively reaches dotenv loading or the credential vault beyond the tracked baseline', () => {
    for (const file of closure.files) {
      const relativePath = relative(repoRoot, file);
      if (!FORBIDDEN_MODULES.has(relativePath)) continue;
      const trackedBy = KNOWN_VIOLATIONS.get(relativePath);
      expect(
        trackedBy,
        `agent closure reaches forbidden module ${relativePath} with no tracking bead via:\n  ${importChain(closure.parents, file)}`,
      ).toBeDefined();
    }
  });

  it('keeps the known-violation baseline honest: every entry must still be a live violation', () => {
    const reached = new Set(
      [...closure.files].map((file) => relative(repoRoot, file)).filter((path) => FORBIDDEN_MODULES.has(path)),
    );
    for (const [modulePath, bead] of KNOWN_VIOLATIONS) {
      expect(
        reached.has(modulePath),
        `stale baseline entry: ${modulePath} (${bead}) is no longer reached — remove the entry and close the bead`,
      ).toBe(true);
    }
  });

  it('walks a non-trivial closure (sanity: the walker is not silently empty)', () => {
    expect(closure.files.size).toBeGreaterThan(10);
  });
});
