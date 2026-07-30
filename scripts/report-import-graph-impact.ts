#!/usr/bin/env tsx

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { isRecord } from '../src/shared/utils/types.js';
import {
  buildImportGraph,
  collectSourceFiles,
  findTransitiveDependents,
  matchRegisteredSeams,
  normalizeRepoPath,
  toPosix,
} from './lib/import-graph.js';

const SOURCE_ROOT = resolve(process.cwd(), 'src');
const DEFAULT_REGISTRY_PATH = resolve(process.cwd(), 'config/import-graph-seams.json');
const MAX_REPORTED_DEPENDENTS = 60;

interface SeamDefinition {
  path: string;
  label: string;
}

interface Options {
  base: string;
  head: string;
  changedFiles: string[];
  registryPath: string;
}

function printUsage(): void {
  console.log('Usage: tsx scripts/report-import-graph-impact.ts [options]');
  console.log('');
  console.log('Reports transitive dependents when changed files match registered seam files.');
  console.log('This check is informational and always exits successfully.');
  console.log('');
  console.log('Options:');
  console.log('  --base <ref>          Git diff base (required unless --changed-file is used)');
  console.log('  --head <ref>          Git diff head (default: HEAD)');
  console.log('  --changed-file <path> Supply a changed file directly; may be repeated');
  console.log('  --registry <path>     Override the seam registry JSON path');
  console.log('  -h, --help            Show this help');
}

function parseArgs(argv: readonly string[]): Options | null {
  let base = '';
  let head = 'HEAD';
  let registryPath = DEFAULT_REGISTRY_PATH;
  const changedFiles: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      return null;
    }

    if (arg === '--base' || arg === '--head' || arg === '--changed-file' || arg === '--registry') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === '--base') base = value;
      if (arg === '--head') head = value;
      if (arg === '--changed-file') changedFiles.push(value);
      if (arg === '--registry') registryPath = resolve(process.cwd(), value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (changedFiles.length === 0 && !base) {
    throw new Error('--base is required unless at least one --changed-file is supplied');
  }

  return { base, head, changedFiles, registryPath };
}

function loadRegistry(registryPath: string): SeamDefinition[] {
  const parsed: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.seams)) {
    throw new Error('Seam registry must have schemaVersion 1 and a seams array');
  }

  const seams: SeamDefinition[] = [];
  const seenPaths = new Set<string>();
  for (const [index, value] of parsed.seams.entries()) {
    if (
      !isRecord(value)
      || typeof value.path !== 'string'
      || value.path.trim().length === 0
      || typeof value.label !== 'string'
      || value.label.trim().length === 0
    ) {
      throw new Error(`Seam registry entry ${index} must contain non-empty path and label strings`);
    }
    const path = normalizeRepoPath(value.path.trim());
    if (!path.startsWith('src/')) {
      throw new Error(`Seam registry entry ${index} must be beneath src/: ${path}`);
    }
    if (seenPaths.has(path)) {
      throw new Error(`Seam registry contains duplicate path: ${path}`);
    }
    seenPaths.add(path);
    seams.push({ path, label: value.label.trim() });
  }

  return seams;
}

function collectChangedFiles(options: Options): string[] {
  if (options.changedFiles.length > 0) {
    return options.changedFiles;
  }

  const mergeBase = execFileSync(
    'git',
    ['merge-base', options.base, options.head],
    { encoding: 'utf8' },
  ).trim();
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '-M', mergeBase, options.head],
    { encoding: 'utf8' },
  ).trim();
  return output ? output.split('\n') : [];
}

function groupBySourceArea(paths: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const pathValue of paths) {
    const segments = pathValue.split('/');
    const group = segments.length >= 2 ? segments.slice(0, 2).join('/') : pathValue;
    const groupPaths = groups.get(group) ?? [];
    groupPaths.push(pathValue);
    groups.set(group, groupPaths);
  }
  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function formatImpact(
  seam: SeamDefinition,
  dependentPaths: readonly string[],
): string {
  const visible = dependentPaths.slice(0, MAX_REPORTED_DEPENDENTS);
  const omitted = dependentPaths.length - visible.length;
  const groups = groupBySourceArea(visible);
  const lines = [
    `Import-graph impact for ${seam.label} (${seam.path}): ${dependentPaths.length} transitive dependent module(s).`,
  ];

  if (visible.length === 0) {
    lines.push('- No transitive dependents found.');
  } else {
    for (const [group, paths] of groups) {
      lines.push(`- ${group} (${paths.length})`);
      for (const pathValue of paths) {
        lines.push(`  - ${pathValue}`);
      }
    }
  }
  if (omitted > 0) {
    lines.push(`- … ${omitted} additional module(s) omitted.`);
  }

  return lines.join('\n');
}

function escapeAnnotation(value: string): string {
  return value
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function emitImpact(seam: SeamDefinition, report: string): void {
  console.log(report);
  console.log(
    `::notice title=${escapeAnnotation(`Import impact: ${seam.label}`)}::${escapeAnnotation(report)}`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${report}\n\n`);
  }
}

function emitInformationalFailure(error: unknown): void {
  const message = `Import-graph impact report skipped: ${
    error instanceof Error ? error.message : String(error)
  }`;
  console.warn(`::warning title=Import-graph impact unavailable::${escapeAnnotation(message)}`);
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) return;
    const registry = loadRegistry(options.registryPath);
    const changedFiles = collectChangedFiles(options);
    const matchedPaths = matchRegisteredSeams(
      changedFiles,
      registry.map(seam => seam.path),
    );
    if (matchedPaths.length === 0) return;

    const files = collectSourceFiles(SOURCE_ROOT, false);
    const { graph } = buildImportGraph(files, SOURCE_ROOT);
    const registryByPath = new Map(registry.map(seam => [seam.path, seam]));

    for (const matchedPath of matchedPaths) {
      const seam = registryByPath.get(matchedPath);
      if (!seam) continue;
      const seamAbsolutePath = resolve(process.cwd(), seam.path);
      const dependents = findTransitiveDependents(graph, seamAbsolutePath)
        .map(pathValue => toPosix(relative(process.cwd(), pathValue)));
      emitImpact(seam, formatImpact(seam, dependents));
    }
  } catch (error) {
    emitInformationalFailure(error);
  }
}

main();
