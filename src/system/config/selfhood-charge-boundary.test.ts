import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Law 38 selfhood/charge boundary (psfn-framework-emh3p.5).
//
// Core functionality is never metered: memory recall, retrieval of her own
// lived history, context assembly, identity and persona state, and emotional
// continuity. Those operations must not reference the charge system at all —
// if it is configurable, it can be configured, and then Law 38 is a
// convention instead of a contract (operator ruling 2026-07-29). This walks
// the selfhood modules' direct import specifiers and fails closed on any
// reference to the charge subsystem.
//
// Deliberately out of scope: embedding accounting (external embeddings are
// real provider spend and a legitimate charge surface), memory writes
// (covered by the removed memoryWrite surface), and orchestrators above the
// selfhood modules that legitimately wire both sides.

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

const CHARGE_SPECIFIER_PATTERN = /(?:^|\/)(charge-policy|run-charge|charge-ledger|charge-cost-reconciliation)(\.|$|\/)/;

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

describe('Law 38 selfhood/charge boundary', () => {
  it('selfhood modules never import the charge subsystem', () => {
    const offenders: Array<{ file: string; specifier: string }> = [];
    for (const path of SELFHOOD_PATHS) {
      for (const file of listSourceFiles(path)) {
        const source = readFileSync(file, 'utf-8');
        for (const match of source.matchAll(IMPORT_PATTERN)) {
          // RegExpMatchArray types optional capture groups as always-present;
          // widen before selecting the first matched group.
          const groups: Array<string | undefined> = match.slice(1);
          const specifier = groups.find(group => group !== undefined) ?? '';
          if (CHARGE_SPECIFIER_PATTERN.test(specifier)) {
            offenders.push({ file: file.slice(file.indexOf('src/')), specifier });
          }
        }
      }
    }
    expect(
      offenders,
      `core selfhood modules must not reference the charge system (charter Law 38):\n${
        offenders.map(o => `  ${o.file} imports ${o.specifier}`).join('\n')}`,
    ).toEqual([]);
  });
});
