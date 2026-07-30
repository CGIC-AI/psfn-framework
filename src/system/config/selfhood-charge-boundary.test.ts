import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHARGE_POLICY_SURFACE_VALUES } from '../../shared/contracts/charge-policy.js';

// Law 38 selfhood/charge boundary (psfn-framework-emh3p.5, hrmrq.42).
//
// Core functionality is never metered: memory recall, retrieval of her own
// lived history, context assembly, identity and persona state, and emotional
// continuity. Owner-file access, local filesystem access, embeddings, and
// other native baseline work are likewise never charge surfaces. Charge is
// reserved for explicitly sanctioned external/consumptive usage. If a native
// process is configurable as a charge surface, it can be configured, and then
// Law 38 is a convention instead of a contract (operator rulings 2026-07-29
// and 2026-07-30).
//
// This test therefore enforces both sides of the boundary:
// 1. every charge surface must be on the sanctioned consumptive allowlist;
// 2. selfhood and native baseline modules must not import runtime metering.

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const SANCTIONED_CONSUMPTIVE_CHARGE_SURFACES = [
  'localImageGeneration',
  'paidImageGeneration',
  'analysisWorkbenchExtensionBand',
  'subagentLaunch',
  'shardLaunch',
  'externalModelConsult',
  'moaRoundBase',
  'companionSocialContinuation',
] as const;

const SELFHOOD_PATHS = [
  'src/faculties/memory/retrieval.ts',
  'src/faculties/memory/retrieval',
  'src/faculties/memory/active-context.ts',
  'src/core/session/manager/context-builder.ts',
  'src/core/session/context-manifest.ts',
  'src/core/identity',
  'src/core/emotion',
  'src/core/self-model',
];

const NATIVE_BASELINE_PATHS = [
  'src/faculties/memory',
  'src/system/config',
  'src/boundary/integrations/filesystem',
  'src/boundary/gateway/filesystem-paths.ts',
  'src/boundary/gateway/methods/fs.ts',
  'src/persistence/pinned-filesystem.ts',
  'src/shared/utils/fs.ts',
];

const CHARGE_SPECIFIER_PATTERN = /(?:^|\/)(charge-policy|run-charge|charge-ledger|charge-cost-reconciliation)(\.|$|\/)/;
const RUNTIME_METERING_SPECIFIER_PATTERN = /(?:^|\/)(run-charge|charge-ledger|charge-cost-reconciliation)(\.|$|\/)/;
const CHARGE_ATTRIBUTION_PATTERN = /\b(?:chargeLane|chargeSurface|chargeEventId|chargeRunId|chargeRootRunId|chargeParentRunId)\b/g;

const IMPORT_PATTERN = /(?:import|export)\s+[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function listSourceFiles(path: string): string[] {
  const full = resolve(srcRoot, path.startsWith('src/') ? `../${path}` : path);
  if (!statSync(full, { throwIfNoEntry: false })) {
    throw new Error(`Law 38 boundary test: expected selfhood path is missing: ${path}`);
  }
  if (statSync(full).isFile()) {
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(full)) {
    const child = join(full, entry);
    if (statSync(child).isDirectory()) {
      files.push(...listSourceFiles(child));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(child);
    }
  }
  return files;
}

function findChargeImports(
  paths: readonly string[],
  pattern: RegExp,
): Array<{ file: string; specifier: string }> {
  const offenders: Array<{ file: string; specifier: string }> = [];
  for (const path of paths) {
    for (const file of listSourceFiles(path)) {
      const source = readFileSync(file, 'utf-8');
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        // RegExpMatchArray types optional capture groups as always-present;
        // widen before selecting the first matched group.
        const groups: Array<string | undefined> = match.slice(1);
        const specifier = groups.find(group => group !== undefined) ?? '';
        if (pattern.test(specifier)) {
          offenders.push({ file: file.slice(file.indexOf('src/')), specifier });
        }
      }
    }
  }
  return offenders;
}

describe('Law 38 selfhood/charge boundary', () => {
  it('permits only explicitly sanctioned external or consumptive charge surfaces', () => {
    expect(
      CHARGE_POLICY_SURFACE_VALUES,
      'every charge surface requires an explicit external/consumptive boundary ruling',
    ).toEqual(SANCTIONED_CONSUMPTIVE_CHARGE_SURFACES);
  });

  it('selfhood modules never import the charge subsystem', () => {
    const offenders = findChargeImports(SELFHOOD_PATHS, CHARGE_SPECIFIER_PATTERN);
    expect(
      offenders,
      `core selfhood modules must not reference the charge system (charter Law 38):\n${
        offenders.map(o => `  ${o.file} imports ${o.specifier}`).join('\n')}`,
    ).toEqual([]);
  });

  it('native owner-file, filesystem, and embedding modules never import runtime metering', () => {
    const offenders = findChargeImports(
      NATIVE_BASELINE_PATHS,
      RUNTIME_METERING_SPECIFIER_PATTERN,
    );
    expect(
      offenders,
      `native baseline modules must not reference runtime charge metering (charter Law 38):\n${
        offenders.map(o => `  ${o.file} imports ${o.specifier}`).join('\n')}`,
    ).toEqual([]);
  });

  it('native baseline modules never attach charge attribution', () => {
    const offenders: Array<{ file: string; field: string }> = [];
    for (const path of NATIVE_BASELINE_PATHS) {
      for (const file of listSourceFiles(path)) {
        const source = readFileSync(file, 'utf-8');
        for (const match of source.matchAll(CHARGE_ATTRIBUTION_PATTERN)) {
          offenders.push({
            file: file.slice(file.indexOf('src/')),
            field: match[0],
          });
        }
      }
    }
    expect(
      offenders,
      `native baseline modules must not attach charge attribution (charter Law 38):\n${
        offenders.map(o => `  ${o.file} references ${o.field}`).join('\n')}`,
    ).toEqual([]);
  });
});
