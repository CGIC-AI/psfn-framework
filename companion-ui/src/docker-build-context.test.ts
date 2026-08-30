// @vitest-environment node

import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const COMPANION_UI_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(COMPANION_UI_ROOT, '..');
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'docker/companion-ui/Dockerfile');
const TSCONFIG_PATH = resolve(COMPANION_UI_ROOT, 'tsconfig.json');
const COMPANION_UI_PREFIX = `${COMPANION_UI_ROOT}${sep}`;

function parseCompanionUiSources(): {
  fileNames: readonly string[];
  options: ts.CompilerOptions;
} {
  const config = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, COMPANION_UI_ROOT);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(error => (
      ts.flattenDiagnosticMessageText(error.messageText, '\n')
    )).join('\n'));
  }
  return { fileNames: parsed.fileNames, options: parsed.options };
}

function resolveRelativeSourceImport(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
): string | null {
  if (!specifier.startsWith('.') || specifier.endsWith('.css')) return null;
  const sourceSpecifier = specifier.replace(/\?(?:worker&url|url)$/u, '');
  const resolved = ts.resolveModuleName(sourceSpecifier, containingFile, options, ts.sys)
    .resolvedModule?.resolvedFileName;
  if (!resolved) {
    throw new Error(`Unable to resolve ${specifier} from ${relative(REPO_ROOT, containingFile)}`);
  }
  return resolve(resolved);
}

function requiredFrameworkSources(): string[] {
  const config = parseCompanionUiSources();
  const pending = [...config.fileNames];
  const visited = new Set<string>();
  const frameworkSources = new Set<string>();

  while (pending.length > 0) {
    const file = resolve(pending.pop() as string);
    if (visited.has(file)) continue;
    visited.add(file);

    const imports = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles;
    for (const imported of imports) {
      const dependency = resolveRelativeSourceImport(imported.fileName, file, config.options);
      if (!dependency) continue;
      pending.push(dependency);
      if (!dependency.startsWith(COMPANION_UI_PREFIX)) {
        frameworkSources.add(relative(REPO_ROOT, dependency));
      }
    }
  }

  return [...frameworkSources].sort();
}

function copiedFrameworkSources(): string[] {
  const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8').replace(/\\\r?\n/gu, ' ');
  const copied = new Set<string>();
  for (const line of dockerfile.split(/\r?\n/gu)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens[0]?.toUpperCase() !== 'COPY' || tokens.includes('--from=build')) continue;
    for (const source of tokens.slice(1, -1)) {
      if (source.startsWith('src/')) copied.add(source);
    }
  }
  return [...copied].sort();
}

describe('companion-ui Docker build context', () => {
  it('copies the exact transitive framework source closure required by TypeScript', () => {
    expect(copiedFrameworkSources()).toEqual(requiredFrameworkSources());
  });
});
