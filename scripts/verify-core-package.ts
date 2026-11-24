#!/usr/bin/env tsx

/**
 * Standalone verification gate for the companion core package (`packages/core/`).
 *
 * Enforces:
 * 1. `packages/core/package.json` declares ONLY the allowed core runtime
 *    dependencies (zero Discord, Redis, PDF, character-card parser, or gateway
 *    packages) and matches root pinned versions.
 * 2. Builds `packages/core` cleanly (`dist/` ESM + `.d.ts` + workers + synced
 *    `config/*.seed.json` + `LICENSE`).
 * 3. Scans ALL emitted `packages/core/dist/**\/*.{js,d.ts}` imports to assert:
 *    - ZERO excluded / non-core external packages
 *    - ZERO relative escapes back into `../../src/`
 * 4. Runs `npm pack` into a temporary directory, asserts required tarball
 *    entries exist, extracts into a clean isolated directory whose
 *    `node_modules/` symlinks ONLY the 8 declared core packages, and
 *    dynamically `import()`s all 5 public subpaths (`.`, `./ports`,
 *    `./lifecycle`, `./operator`, `./seeds`) to prove standalone runtime
 *    loadability with zero host packages installed.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { buildCorePackage } from './build-core-package.js';
import { COMPANION_SEED_FILES } from '../packages/core/src/seeds.js';

const ROOT_DIR = process.cwd();
const PACKAGE_DIR = resolve(ROOT_DIR, 'packages/core');
const DIST_DIR = join(PACKAGE_DIR, 'dist');

const ALLOWED_CORE_DEPENDENCIES = new Set([
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@huggingface/transformers',
  '@sinclair/typebox',
  'js-tiktoken',
  'pg',
  'uuid',
  'winston',
]);

const FORBIDDEN_PACKAGES = new Set([
  '@character-foundry/character-foundry',
  '@discordjs/voice',
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/server',
  '@peculiar/x509',
  '@redis/client',
  '@snazzah/davey',
  'discord.js',
  'ipaddr.js',
  'json-rpc-2.0',
  'opusscript',
  'pdfjs-dist',
  'prism-media',
  'redis',
  'ioredis',
  'ws',
  'yaml',
]);

function readJson(pathValue: string): Record<string, unknown> {
  return JSON.parse(readFileSync(pathValue, 'utf-8')) as Record<string, unknown>;
}

function collectDistFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectDistFiles(full));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

function extractModuleSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf-8');
  const scriptKind = filePath.endsWith('.d.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specifiers;
}

function normalizePackageName(specifier: string): string {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!;
}

function verifyPackageManifest(): { name: string; version: string; dependencies: Record<string, string> } {
  const rootPkg = readJson(resolve(ROOT_DIR, 'package.json'));
  const corePkg = readJson(join(PACKAGE_DIR, 'package.json'));
  const rootDeps = (rootPkg.dependencies ?? {}) as Record<string, string>;
  const coreDeps = (corePkg.dependencies ?? {}) as Record<string, string>;

  const violations: string[] = [];
  for (const [dep, version] of Object.entries(coreDeps)) {
    if (FORBIDDEN_PACKAGES.has(dep) || !ALLOWED_CORE_DEPENDENCIES.has(dep)) {
      violations.push(`Disallowed dependency in packages/core/package.json: ${dep}@${version}`);
    }
    if (rootDeps[dep] && rootDeps[dep] !== version) {
      violations.push(
        `Version drift for ${dep}: packages/core has ${version}, root package.json has ${rootDeps[dep]}`,
      );
    }
  }
  for (const required of ALLOWED_CORE_DEPENDENCIES) {
    if (!(required in coreDeps)) {
      violations.push(`Missing expected core dependency in packages/core/package.json: ${required}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`Core package manifest verification failed:\n${violations.map(v => `  - ${v}`).join('\n')}`);
  }
  return {
    name: String(corePkg.name),
    version: String(corePkg.version),
    dependencies: coreDeps,
  };
}

function verifyDistClosure(): void {
  const distFiles = collectDistFiles(DIST_DIR);
  if (distFiles.length === 0) {
    throw new Error('No emitted files found in packages/core/dist');
  }
  const requiredOutputs = [
    'index.js',
    'index.d.ts',
    'ports.js',
    'ports.d.ts',
    'lifecycle.js',
    'lifecycle.d.ts',
    'operator.js',
    'operator.d.ts',
    'seeds.js',
    'seeds.d.ts',
    'turn-record-recovery-worker.js',
    'turn-tombstone-authority-worker.js',
  ];
  for (const file of requiredOutputs) {
    if (!existsSync(join(DIST_DIR, file))) {
      throw new Error(`Missing required build output: packages/core/dist/${file}`);
    }
  }

  const violations: string[] = [];
  for (const file of distFiles) {
    const rel = file.slice(PACKAGE_DIR.length + 1);
    for (const specifier of extractModuleSpecifiers(file)) {
      if (isBuiltin(specifier)) continue;
      if (specifier.startsWith('.')) {
        const resolved = resolve(dirname(file), specifier);
        if (!resolved.startsWith(PACKAGE_DIR + '/')) {
          violations.push(`${rel} escapes package root via relative specifier "${specifier}"`);
        }
        continue;
      }
      const pkgName = normalizePackageName(specifier);
      if (FORBIDDEN_PACKAGES.has(pkgName) || !ALLOWED_CORE_DEPENDENCIES.has(pkgName)) {
        violations.push(`${rel} imports non-core package "${specifier}"`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Core dist import verification failed:\n${violations.map(v => `  - ${v}`).join('\n')}`);
  }
}

function verifyPackAndIsolatedImport(pkgName: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'core-pkg-verify-'));
  try {
    const packOut = execFileSync(
      'npm',
      ['pack', '--pack-destination', scratch, '--json'],
      { cwd: PACKAGE_DIR, encoding: 'utf-8' },
    );
    const packEntries = JSON.parse(packOut) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const tarballName = packEntries[0]?.filename;
    if (!tarballName) throw new Error('npm pack did not report a tarball filename');
    const packedPaths = new Set((packEntries[0]?.files ?? []).map(f => f.path));

    for (const seed of COMPANION_SEED_FILES) {
      if (!packedPaths.has(`config/${seed}`)) {
        throw new Error(`Tarball is missing required seed file: config/${seed}`);
      }
    }
    if (!packedPaths.has('LICENSE')) {
      throw new Error('Tarball is missing LICENSE');
    }

    const consumerDir = join(scratch, 'consumer');
    const pkgInstallDir = join(consumerDir, 'node_modules', ...pkgName.split('/'));
    mkdirSync(pkgInstallDir, { recursive: true });
    execFileSync('tar', ['-xzf', join(scratch, tarballName), '--strip-components=1', '-C', pkgInstallDir]);

    // Symlink ONLY the 8 declared core packages (and their transitive deps via
    // root node_modules resolution for those packages) into consumer/node_modules
    // so the packaged bundle itself can only resolve its 8 declared deps.
    for (const dep of ALLOWED_CORE_DEPENDENCIES) {
      const target = resolve(ROOT_DIR, 'node_modules', ...dep.split('/'));
      const linkPath = join(consumerDir, 'node_modules', ...dep.split('/'));
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(target, linkPath, 'dir');
    }

    const smokeScript = `
      import { existsSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      const core = await import(${JSON.stringify(pkgName)});
      const ports = await import(${JSON.stringify(`${pkgName}/ports`)});
      const lifecycle = await import(${JSON.stringify(`${pkgName}/lifecycle`)});
      const operator = await import(${JSON.stringify(`${pkgName}/operator`)});
      const seeds = await import(${JSON.stringify(`${pkgName}/seeds`)});

      const checks = [
        ['startCompanionRuntime', typeof core.startCompanionRuntime === 'function'],
        ['loadInnerLifeConfig', typeof core.loadInnerLifeConfig === 'function'],
        ['HostedAutomataExecutor', typeof core.HostedAutomataExecutor === 'function'],
        ['CANONICAL_FIRST_PARTY_TOOL_SURFACES', Array.isArray(core.CANONICAL_FIRST_PARTY_TOOL_SURFACES) && core.CANONICAL_FIRST_PARTY_TOOL_SURFACES.length > 0],
        ['EMPTY_PERSONAL_PROJECTS', typeof ports.EMPTY_PERSONAL_PROJECTS?.listProjects === 'function'],
        ['lifecycle.HostedAutomataExecutor', lifecycle.HostedAutomataExecutor === core.HostedAutomataExecutor],
        ['lifecycle.getRequestContext', typeof lifecycle.getRequestContext === 'function'],
        ['operator.buildAdminMemoryRoutes', typeof operator.buildAdminMemoryRoutes === 'function'],
        ['operator.AdminIdentityDataService', typeof operator.AdminIdentityDataService === 'function'],
        ['operator.normalizeImportedCard', typeof operator.normalizeImportedCard === 'function'],
        ['seeds.COMPANION_SEED_DIR', seeds.COMPANION_SEED_DIR instanceof URL && existsSync(fileURLToPath(seeds.COMPANION_SEED_DIR))],
        ['seeds.COMPANION_SEED_FILES', Array.isArray(seeds.COMPANION_SEED_FILES) && seeds.COMPANION_SEED_FILES.length === 9],
      ];
      const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
      if (failed.length > 0) {
        console.error('Failed isolated import checks:', failed);
        process.exit(1);
      }
      console.log('Isolated smoke import passed:', checks.length, 'assertions');
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', smokeScript], {
      cwd: consumerDir,
      stdio: 'inherit',
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  const manifest = verifyPackageManifest();
  console.log(`[verify-core-package] Manifest OK: ${manifest.name}@${manifest.version} (${Object.keys(manifest.dependencies).length} core deps)`);
  buildCorePackage();
  verifyDistClosure();
  console.log('[verify-core-package] Dist closure OK: 0 forbidden packages, 0 root escapes');
  verifyPackAndIsolatedImport(manifest.name);
  console.log(`[verify-core-package] PASS: ${manifest.name}@${manifest.version} verified end-to-end.`);
}

main();
