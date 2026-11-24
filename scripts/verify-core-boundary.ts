#!/usr/bin/env tsx

/**
 * Core-to-host import boundary ratchet gate (psfn-framework-kbdvl.1).
 *
 * Ensures the companion core domain set does not acquire new imports into
 * full-framework host scaffolding (Gateway, Fleet Auth, Custody, CogSec
 * screening/custody, Fatigue, Arbiter, Channels, Voice, Images, Wiki, Skills,
 * Shards, Operator UI, and host entrypoints).
 *
 * The baseline in `config/core-boundary-baseline.json` is strictly
 * reduction-only:
 * - Any detected edge not in the baseline fails closed.
 * - Any stale baseline entry that no longer exists fails closed (run with
 *   `--update` to shrink the baseline after burning down edges).
 * - `--update` refuses to add new edges; it may only prune resolved ones.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { isRecord } from '../src/shared/utils/types.js';
import {
  buildImportGraph,
  collectSourceFiles,
  toPosix,
} from './lib/import-graph.js';

const DEFAULT_BASELINE_PATH = resolve(process.cwd(), 'config/core-boundary-baseline.json');

/**
 * Host-scaffolding prefixes outside the `@psfn/core` boundary.
 * Entries ending with `.ts` match exact repo-relative `src/` paths;
 * entries ending with `/` match the entire subtree; other entries match by prefix.
 */
export const HOST_ONLY_PREFIXES = Object.freeze([
  'app/cert-manager/',
  'app/cli/',
  'app/e2e/',
  'app/gateway/',
  'app/maintenance/',
  'app/operator/',
  'app/agent/main.ts',
  'app/agent/api-backend-wiring.ts',
  'app/agent/cognition-intake-wiring.ts',
  'app/agent/proactive-lanes-wiring.ts',
  'app/agent/core-runtime.ts',
  'app/startup/index.ts',
  'boundary/custody/',
  'boundary/fleet-auth/',
  'boundary/gateway/',
  'boundary/sandbox/',
  'channels/',
  'core/agent/arbiter/',
  'core/agent/fatigue/',
  'core/cogsec/intake/screening',
  'core/cogsec/intake/sink-gates',
  'core/cogsec/intake/scanners/',
  'core/cogsec/intake/marking',
  'core/cogsec/disclosure/index.ts',
  'core/cogsec/disclosure/custody',
  'core/cogsec/disclosure/capsule',
  'core/cogsec/disclosure/publication',
  'core/cogsec/regeneration',
  'core/cogsec/canary',
  'core/cogsec/drift',
  'core/cogsec/second-arrow',
  'core/cogsec/persona-conformance',
  'core/cogsec/remediation',
  'core/cogsec/quarantine',
  'core/cogsec/approval',
  'core/enrollment/',
  'core/participation/',
  'core/scheduler/fleet-maintenance',
  'faculties/file-ingest/',
  'faculties/shards/context-pack',
  'faculties/shards/manager',
  'faculties/shards/executor',
  'faculties/shards/store',
  'faculties/shards/postgres',
  'faculties/shards/runner',
  'faculties/shards/tool',
  'faculties/skills/',
  'faculties/wiki/',
  'operator/',
  'persistence/backups/',
  'persistence/importers/',
  'persistence/workspaces/',
  'persistence/postgres/fleet-auth/',
  'primitives/images/fal',
  'primitives/images/comfy',
  'primitives/images/openrouter',
  'primitives/images/types.ts',
  'primitives/images/generated-media.ts',
  'primitives/images/service',
  'primitives/images/gallery',
  'primitives/images/selfie',
  'primitives/images/vision-review',
  'primitives/voice/',
  'system/fleet-lifecycle/',
  'system/modules/',
]);

export function isHostOnlySourcePath(srcRelativePath: string): boolean {
  const normalized = toPosix(srcRelativePath);
  return HOST_ONLY_PREFIXES.some((prefix) => (
    prefix.endsWith('.ts') ? normalized === prefix : normalized.startsWith(prefix)
  ));
}

export interface CoreBoundaryBaseline {
  schemaVersion: 1;
  remediationTracker: string;
  edges: string[];
}

export interface CoreBoundaryEvaluation {
  coreFileCount: number;
  hostFileCount: number;
  detectedEdges: string[];
  newEdges: string[];
  staleEdges: string[];
}

export function detectCoreToHostEdges(sourceRoot: string): {
  coreFileCount: number;
  hostFileCount: number;
  edges: string[];
} {
  const files = collectSourceFiles(sourceRoot, false);
  const { graph } = buildImportGraph(files, sourceRoot);
  const detected = new Set<string>();
  let coreFileCount = 0;
  let hostFileCount = 0;

  for (const file of files) {
    const rel = toPosix(relative(sourceRoot, file));
    if (isHostOnlySourcePath(rel)) {
      hostFileCount += 1;
      continue;
    }
    coreFileCount += 1;
    const deps = graph.get(file) ?? [];
    for (const dep of deps) {
      const depRel = toPosix(relative(sourceRoot, dep));
      if (isHostOnlySourcePath(depRel)) {
        detected.add(`${rel} -> ${depRel}`);
      }
    }
  }

  return {
    coreFileCount,
    hostFileCount,
    edges: [...detected].sort(),
  };
}

export function loadCoreBoundaryBaseline(pathValue: string): CoreBoundaryBaseline {
  let raw: string;
  try {
    raw = readFileSync(pathValue, 'utf-8');
  } catch (error) {
    throw new Error(`Unable to read core boundary baseline: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Core boundary baseline is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || typeof parsed.remediationTracker !== 'string'
    || parsed.remediationTracker.trim().length === 0
    || !Array.isArray(parsed.edges)) {
    throw new Error('Core boundary baseline must have schemaVersion: 1, remediationTracker, and edges array.');
  }

  const seen = new Set<string>();
  const edges: string[] = [];
  for (let index = 0; index < parsed.edges.length; index += 1) {
    const edge = parsed.edges[index];
    if (typeof edge !== 'string' || !edge.includes(' -> ')) {
      throw new Error(`Core boundary baseline edge at index ${index} must be a "<src> -> <target>" string.`);
    }
    if (seen.has(edge)) {
      throw new Error(`Duplicate core boundary baseline edge: ${edge}`);
    }
    seen.add(edge);
    edges.push(edge);
  }

  return {
    schemaVersion: 1,
    remediationTracker: parsed.remediationTracker,
    edges: edges.sort(),
  };
}

export function evaluateCoreBoundary(
  sourceRoot: string,
  baseline: CoreBoundaryBaseline,
): CoreBoundaryEvaluation {
  const { coreFileCount, hostFileCount, edges } = detectCoreToHostEdges(sourceRoot);
  const baselineSet = new Set(baseline.edges);
  const detectedSet = new Set(edges);

  return {
    coreFileCount,
    hostFileCount,
    detectedEdges: edges,
    newEdges: edges.filter((edge) => !baselineSet.has(edge)),
    staleEdges: baseline.edges.filter((edge) => !detectedSet.has(edge)),
  };
}

function parseArgs(argv: string[]): { baselinePath: string; update: boolean } {
  let baselinePath = DEFAULT_BASELINE_PATH;
  let update = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update') {
      update = true;
    } else if (arg === '--baseline') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --baseline');
      baselinePath = resolve(process.cwd(), value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx scripts/verify-core-boundary.ts [--baseline <path>] [--update]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { baselinePath, update };
}

function main(): void {
  const { baselinePath, update } = parseArgs(process.argv.slice(2));
  const sourceRoot = resolve(process.cwd(), 'src');
  const baseline = loadCoreBoundaryBaseline(baselinePath);
  const evaluation = evaluateCoreBoundary(sourceRoot, baseline);

  if (update) {
    if (evaluation.newEdges.length > 0) {
      console.error(
        `[verify-core-boundary] Refusing --update: ${evaluation.newEdges.length} new core->host edge(s) detected (baseline is reduction-only):`,
      );
      for (const edge of evaluation.newEdges) console.error(`  + ${edge}`);
      process.exit(1);
    }
    const next: CoreBoundaryBaseline = {
      schemaVersion: 1,
      remediationTracker: baseline.remediationTracker,
      edges: evaluation.detectedEdges,
    };
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    console.log(
      `[verify-core-boundary] Updated baseline (${baseline.edges.length} -> ${next.edges.length} edge(s); pruned ${evaluation.staleEdges.length}).`,
    );
    return;
  }

  if (evaluation.newEdges.length > 0 || evaluation.staleEdges.length > 0) {
    console.error(
      `[verify-core-boundary] FAIL: ${evaluation.detectedEdges.length} core->host edge(s) across ${evaluation.coreFileCount} core files (baseline: ${baseline.edges.length}).`,
    );
    if (evaluation.newEdges.length > 0) {
      console.error('New forbidden core->host import edges:');
      for (const edge of evaluation.newEdges) console.error(`  + ${edge}`);
    }
    if (evaluation.staleEdges.length > 0) {
      console.error('Stale baseline entries (run `npm run verify:core-boundary -- --update` to prune):');
      for (const edge of evaluation.staleEdges) console.error(`  - ${edge}`);
    }
    process.exit(1);
  }

  console.log(
    `[verify-core-boundary] PASS: ${evaluation.detectedEdges.length} baselined core->host edge(s) across ${evaluation.coreFileCount} core files (${evaluation.hostFileCount} host files; tracker ${baseline.remediationTracker}).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
