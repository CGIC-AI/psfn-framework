#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { isRecord } from '../src/shared/utils/types.js';
import {
  buildImportGraph,
  collectSourceFiles,
  toPosix,
} from './lib/import-graph.js';

const SOURCE_ROOT = resolve(process.cwd(), 'src');
const DEFAULT_BASELINE_PATH = resolve(process.cwd(), 'config/dependency-cycle-baseline.json');

function printUsage() {
  console.log('Usage: tsx scripts/check-dependency-cycles.ts [options]');
  console.log('');
  console.log('Checks src/ import graph for circular dependencies.');
  console.log('Fails on any cycle not present in the configured baseline file.');
  console.log('Also fails on stale baseline entries that no longer match a detected cycle.');
  console.log('');
  console.log('Options:');
  console.log('  --baseline <path>   Override baseline JSON path');
  console.log('  --include-tests     Include *.test.ts files in graph');
  console.log('  -h, --help          Show this help');
}

function parseArgs(argv) {
  let includeTests = false;
  let baselinePath = DEFAULT_BASELINE_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--include-tests') {
      includeTests = true;
      continue;
    }
    if (arg === '--baseline') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --baseline');
      }
      baselinePath = resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    includeTests,
    baselinePath,
  };
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

function loadBaseline(pathValue) {
  let parsed;
  let raw;
  try {
    raw = readFileSync(pathValue, 'utf-8');
  } catch (error) {
    throw new Error(`Unable to read baseline file: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Baseline file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Baseline must be a JSON object.');
  }

  if (parsed.schemaVersion !== 1) {
    throw new Error('Baseline schemaVersion must be 1.');
  }

  if (typeof parsed.remediationTracker !== 'string' || parsed.remediationTracker.trim().length === 0) {
    throw new Error('Baseline remediationTracker must be a non-empty string.');
  }

  if (!Array.isArray(parsed.cycles)) {
    throw new Error('Baseline cycles must be an array.');
  }

  const normalizedCycles = [];
  const seen = new Set();
  for (let index = 0; index < parsed.cycles.length; index += 1) {
    const cycle = parsed.cycles[index];
    if (typeof cycle !== 'string') {
      throw new Error(`Baseline cycle at index ${index} must be a string.`);
    }
    const normalized = cycle.trim();
    if (!normalized) {
      throw new Error(`Baseline cycle at index ${index} cannot be empty.`);
    }
    if (seen.has(normalized)) {
      throw new Error(`Baseline contains duplicate cycle entry: "${normalized}".`);
    }
    seen.add(normalized);
    normalizedCycles.push(normalized);
  }

  normalizedCycles.sort();
  return {
    schemaVersion: 1,
    remediationTracker: parsed.remediationTracker.trim(),
    cycles: normalizedCycles,
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const baseline = loadBaseline(options.baselinePath);
    const files = collectSourceFiles(SOURCE_ROOT, options.includeTests);
    const { graph, edgeCount } = buildImportGraph(files, SOURCE_ROOT);
    const cycles = detectCycles(graph);

    console.log(
      `Dependency graph built from ${files.length} source files with ${edgeCount} import edges.`,
    );
    console.log(`Cycle baseline: ${toPosix(relative(process.cwd(), options.baselinePath))}`);
    console.log(
      `Remediation tracker: ${baseline.remediationTracker}.`,
    );

    const baselineSet = new Set(baseline.cycles);
    const detectedSet = new Set(cycles);
    const baselineMatched = cycles.filter(cycle => baselineSet.has(cycle));
    const regressions = cycles.filter(cycle => !baselineSet.has(cycle));
    const baselineOnly = baseline.cycles.filter(cycle => !detectedSet.has(cycle));

    if (baselineMatched.length > 0) {
      console.log(`Baseline-matched cycles (${baselineMatched.length}):`);
      for (const cycle of baselineMatched) {
        console.log(`- ${cycle}`);
      }
    } else {
      console.log('Baseline-matched cycles (0).');
    }

    if (regressions.length > 0) {
      console.error(`Detected ${regressions.length} new circular import cycle(s) outside baseline:`);
      for (const cycle of regressions) {
        console.error(`- ${cycle}`);
      }
      console.error(
        `Dependency-cycle regression check failed. Baseline debt is tracked by ${baseline.remediationTracker}.`,
      );
      process.exitCode = 1;
      return;
    }

    if (baselineOnly.length > 0) {
      console.error(
        `Stale baseline entries not currently detected (${baselineOnly.length}) — prune them from the baseline so it cannot rot (tracked by ${baseline.remediationTracker}):`,
      );
      for (const cycle of baselineOnly) {
        console.error(`- ${cycle}`);
      }
      console.error('Dependency-cycle check failed: stale baseline entries must be pruned.');
      process.exitCode = 1;
      return;
    }

    if (cycles.length === 0) {
      console.log('No circular imports detected.');
    } else {
      console.log(
        `Detected ${cycles.length} circular import cycle(s), all baseline-matched. No regressions against ${baseline.remediationTracker}.`,
      );
    }
  } catch (error) {
    console.error(
      `Dependency-cycle check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

main();
