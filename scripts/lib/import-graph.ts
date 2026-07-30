import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
} from 'node:path';
import type * as TypeScript from 'typescript';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof TypeScript;

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const JS_IMPORT_EXTENSIONS = ['.js', '.mjs', '.cjs'];

export type ImportGraph = ReadonlyMap<string, readonly string[]>;

export interface ImportGraphResult {
  graph: Map<string, string[]>;
  edgeCount: number;
}

export function toPosix(pathValue: string): string {
  return pathValue.split('\\').join('/');
}

export function normalizeRepoPath(pathValue: string): string {
  return toPosix(pathValue).replace(/^\.\//, '');
}

function isSourceFile(pathValue: string): boolean {
  return SOURCE_EXTENSIONS.includes(extname(pathValue));
}

export function collectSourceFiles(rootDir: string, includeTests: boolean): string[] {
  const output: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || !isSourceFile(absolute)) {
        continue;
      }
      if (!includeTests && absolute.endsWith('.test.ts')) {
        continue;
      }
      output.push(resolve(absolute));
    }
  }

  output.sort();
  return output;
}

function extractImportSpecifiers(filePath: string): string[] {
  const sourceText = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = new Set<string>();

  function addSpecifier(moduleSpecifier: TypeScript.Expression | undefined): void {
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
      return;
    }
    const value = moduleSpecifier.text.trim();
    if (value.startsWith('.')) {
      specifiers.add(value);
    }
  }

  function visit(node: TypeScript.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      addSpecifier(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      addSpecifier(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...specifiers];
}

function resolveImportToSource(
  importerPath: string,
  specifier: string,
  sourceRoot: string,
): string | null {
  const importerDir = dirname(importerPath);
  const rawTarget = resolve(importerDir, specifier);
  const targetExt = extname(rawTarget);
  const candidates: string[] = [];

  if (targetExt.length === 0) {
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.push(`${rawTarget}${extension}`);
    }
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.push(join(rawTarget, `index${extension}`));
    }
  } else {
    if (SOURCE_EXTENSIONS.includes(targetExt)) {
      candidates.push(rawTarget);
    }
    if (JS_IMPORT_EXTENSIONS.includes(targetExt)) {
      const base = rawTarget.slice(0, -targetExt.length);
      for (const extension of SOURCE_EXTENSIONS) {
        candidates.push(`${base}${extension}`);
      }
    }
  }

  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    const pathFromRoot = relative(sourceRoot, absolute);
    if (
      pathFromRoot !== '..'
      && !pathFromRoot.startsWith('../')
      && !pathFromRoot.startsWith('..\\')
    ) {
      return absolute;
    }
  }

  return null;
}

export function buildImportGraph(files: readonly string[], sourceRoot: string): ImportGraphResult {
  const fileSet = new Set(files);
  const graph = new Map<string, string[]>();
  let edgeCount = 0;

  for (const filePath of files) {
    const imports = extractImportSpecifiers(filePath);
    const targets = new Set<string>();

    for (const specifier of imports) {
      const resolvedTarget = resolveImportToSource(filePath, specifier, sourceRoot);
      if (!resolvedTarget || !fileSet.has(resolvedTarget)) {
        continue;
      }
      targets.add(resolvedTarget);
    }

    edgeCount += targets.size;
    graph.set(filePath, [...targets].sort());
  }

  return { graph, edgeCount };
}

export function findTransitiveDependents(graph: ImportGraph, target: string): string[] {
  const reverseGraph = new Map<string, Set<string>>();

  for (const [importer, imports] of graph) {
    for (const imported of imports) {
      const dependents = reverseGraph.get(imported) ?? new Set<string>();
      dependents.add(importer);
      reverseGraph.set(imported, dependents);
    }
  }

  const visited = new Set([target]);
  const pending = [...(reverseGraph.get(target) ?? [])].sort().reverse();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const next = [...(reverseGraph.get(current) ?? [])].sort().reverse();
    pending.push(...next);
  }

  visited.delete(target);
  return [...visited].sort();
}

export function matchRegisteredSeams(
  changedFiles: readonly string[],
  registeredSeams: readonly string[],
): string[] {
  const normalizedChangedFiles = new Set(
    changedFiles.map(normalizeRepoPath),
  );

  return registeredSeams
    .map(normalizeRepoPath)
    .filter(pathValue => normalizedChangedFiles.has(pathValue))
    .sort();
}
