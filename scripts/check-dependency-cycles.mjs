#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const SOURCE_ROOT = resolve(process.cwd(), 'src');
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const JS_IMPORT_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const INCLUDE_TESTS = process.argv.includes('--include-tests');

function toPosix(pathValue) {
  return pathValue.split('\\').join('/');
}

function isSourceFile(pathValue) {
  return SOURCE_EXTENSIONS.includes(extname(pathValue));
}

function collectSourceFiles(rootDir) {
  const output = [];
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
      if (!INCLUDE_TESTS && absolute.endsWith('.test.ts')) {
        continue;
      }
      output.push(resolve(absolute));
    }
  }

  output.sort();
  return output;
}

function extractImportSpecifiers(filePath) {
  const sourceText = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = new Set();

  function addSpecifier(moduleSpecifier) {
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
      return;
    }
    const value = moduleSpecifier.text.trim();
    if (value.startsWith('.')) {
      specifiers.add(value);
    }
  }

  function visit(node) {
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

function resolveImportToSource(importerPath, specifier) {
  const importerDir = dirname(importerPath);
  const rawTarget = resolve(importerDir, specifier);
  const targetExt = extname(rawTarget);
  const candidates = [];

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
    if (absolute.startsWith(SOURCE_ROOT)) {
      return absolute;
    }
  }

  return null;
}

function buildGraph(files) {
  const fileSet = new Set(files);
  const graph = new Map();
  let edgeCount = 0;

  for (const filePath of files) {
    const imports = extractImportSpecifiers(filePath);
    const targets = new Set();

    for (const specifier of imports) {
      const resolvedTarget = resolveImportToSource(filePath, specifier);
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

function canonicalizeCycle(cycle) {
  const core = cycle.slice(0, -1);
  if (core.length === 0) {
    return '';
  }

  const forward = [];
  const backward = [];
  for (let i = 0; i < core.length; i += 1) {
    forward.push(core.slice(i).concat(core.slice(0, i)));
    backward.push([...core].reverse().slice(i).concat([...core].reverse().slice(0, i)));
  }

  const all = forward.concat(backward)
    .map((nodes) => nodes.map(node => toPosix(relative(SOURCE_ROOT, node))))
    .map(nodes => nodes.join(' -> '));

  all.sort();
  return all[0] ?? '';
}

function detectCycles(graph) {
  const state = new Map();
  const stack = [];
  const cycles = new Set();

  function visit(node) {
    state.set(node, 1);
    stack.push(node);

    const deps = graph.get(node) ?? [];
    for (const dep of deps) {
      const depState = state.get(dep) ?? 0;
      if (depState === 0) {
        visit(dep);
        continue;
      }
      if (depState === 1) {
        const startIndex = stack.indexOf(dep);
        if (startIndex >= 0) {
          const cycle = stack.slice(startIndex).concat(dep);
          const canonical = canonicalizeCycle(cycle);
          if (canonical) {
            cycles.add(canonical);
          }
        }
      }
    }

    stack.pop();
    state.set(node, 2);
  }

  for (const node of graph.keys()) {
    if ((state.get(node) ?? 0) === 0) {
      visit(node);
    }
  }

  return [...cycles].sort();
}

function main() {
  const files = collectSourceFiles(SOURCE_ROOT);
  const { graph, edgeCount } = buildGraph(files);
  const cycles = detectCycles(graph);

  console.log(
    `Dependency graph built from ${files.length} source files with ${edgeCount} import edges.`,
  );

  if (cycles.length === 0) {
    console.log('No circular imports detected.');
    return;
  }

  console.error(`Detected ${cycles.length} circular import cycle(s):`);
  for (const cycle of cycles) {
    console.error(`- ${cycle}`);
  }
  process.exitCode = 1;
}

main();
