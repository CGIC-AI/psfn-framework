import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildUpdatedBaseline,
  compareFindingsToBaseline,
  extractDeclarationsFromSource,
  findDuplicateTypeNames,
  parseDuplicateTypeBaseline,
  readDuplicateTypeBaseline,
  type DuplicateTypeBaseline,
} from './duplicate-type-names.js';

describe('extractDeclarationsFromSource', () => {
  it('collects only top-level exported interface, type, and enum definitions', () => {
    const declarations = extractDeclarationsFromSource('sample.ts', `
      export interface Alpha { id: string; count?: number }
      export type Beta = 'one' | 'two';
      export enum Gamma { First = 'first', Second = 'second' }
      interface NotExported { id: string }
      export const notAType = 1;
      export { Alpha as Renamed } from './other.js';
      export * from './elsewhere.js';
      declare module 'ambient' { export interface Nested { x: string } }
    `);

    expect(declarations.map(declaration => declaration.name)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('normalizes whitespace, comments, jsdoc, and union member order', () => {
    const left = extractDeclarationsFromSource('left.ts', `
      /** Doc comment. */
      export type Value =
        | 'alpha'
        | 'beta';
    `);
    const right = extractDeclarationsFromSource('right.ts', `
      export type Value = 'beta' | 'alpha'; // trailing comment
    `);

    expect(right[0]?.shape).toBe(left[0]?.shape);
  });

  it('keeps type parameters and member optionality significant', () => {
    const declarations = extractDeclarationsFromSource('generic.ts', `
      export type Awaitable<T> = T | Promise<T>;
      export interface Row { id: string; salience: number | null }
    `);

    expect(declarations[0]?.shape).toContain('<T>');
    expect(declarations[1]?.shape).toContain('salience: number | null');
  });
});

describe('findDuplicateTypeNames', () => {
  it('classifies identical shapes as identical and differing shapes as collision', () => {
    const findings = findDuplicateTypeNames(new Map([
      ['src/a.ts', extractDeclarationsFromSource('src/a.ts', `
        export type Same = 'x' | 'y';
        export type Different = 'one' | 'two';
        export type OnlyHere = string;
      `)],
      ['src/b.ts', extractDeclarationsFromSource('src/b.ts', `
        export type Same = 'y' | 'x';
        export type Different = 'one' | 'two' | 'three';
      `)],
    ]));

    expect(findings).toEqual([
      {
        name: 'Different',
        classification: 'collision',
        declarationKinds: ['type'],
        files: ['src/a.ts', 'src/b.ts'],
      },
      {
        name: 'Same',
        classification: 'identical',
        declarationKinds: ['type'],
        files: ['src/a.ts', 'src/b.ts'],
      },
    ]);
  });

  it('ignores names declared in a single file', () => {
    const findings = findDuplicateTypeNames(new Map([
      ['src/a.ts', extractDeclarationsFromSource('src/a.ts', 'export type Solo = string;')],
    ]));

    expect(findings).toEqual([]);
  });
});

describe('parseDuplicateTypeBaseline', () => {
  const validEntry = {
    name: 'Widget',
    kind: 'identical',
    files: ['src/a.ts', 'src/b.ts'],
    note: 'Reviewed: consolidation candidate.',
  };

  it('accepts a valid baseline', () => {
    expect(parseDuplicateTypeBaseline({ schemaVersion: 1, entries: [validEntry] }))
      .toEqual({ schemaVersion: 1, entries: [validEntry] });
  });

  it('rejects entries without a non-empty review note', () => {
    expect(() => parseDuplicateTypeBaseline({
      schemaVersion: 1,
      entries: [{ ...validEntry, note: '   ' }],
    })).toThrow(/note/u);
  });

  it('rejects unsupported schema versions, unsorted entries, and duplicate names', () => {
    expect(() => parseDuplicateTypeBaseline({ schemaVersion: 2, entries: [] }))
      .toThrow(/schemaVersion/u);
    expect(() => parseDuplicateTypeBaseline({
      schemaVersion: 1,
      entries: [
        { ...validEntry, name: 'Zeta' },
        { ...validEntry, name: 'Alpha' },
      ],
    })).toThrow(/sorted/u);
    expect(() => parseDuplicateTypeBaseline({
      schemaVersion: 1,
      entries: [validEntry, { ...validEntry }],
    })).toThrow(/duplicate entry names/u);
  });

  it('rejects invalid kinds and unsorted file lists', () => {
    expect(() => parseDuplicateTypeBaseline({
      schemaVersion: 1,
      entries: [{ ...validEntry, kind: 'unknown' }],
    })).toThrow(/kind/u);
    expect(() => parseDuplicateTypeBaseline({
      schemaVersion: 1,
      entries: [{ ...validEntry, files: ['src/b.ts', 'src/a.ts'] }],
    })).toThrow(/files must be sorted/u);
  });
});

describe('readDuplicateTypeBaseline', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'duplicate-type-baseline-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('round-trips a written baseline file', () => {
    const path = join(directory, 'baseline.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        name: 'Widget',
        kind: 'collision',
        files: ['src/a.ts', 'src/b.ts'],
        note: 'Reviewed: rename pending.',
      }],
    }), 'utf8');

    expect(readDuplicateTypeBaseline(path).entries).toHaveLength(1);
  });

  it('fails closed on unreadable or invalid files', () => {
    expect(() => readDuplicateTypeBaseline(join(directory, 'missing.json')))
      .toThrow(/Unable to read baseline file/u);
    const invalidPath = join(directory, 'invalid.json');
    writeFileSync(invalidPath, 'not json', 'utf8');
    expect(() => readDuplicateTypeBaseline(invalidPath)).toThrow(/not valid JSON/u);
  });
});

describe('compareFindingsToBaseline', () => {
  const baseline: DuplicateTypeBaseline = {
    schemaVersion: 1,
    entries: [
      {
        name: 'Same',
        kind: 'identical',
        files: ['src/a.ts', 'src/b.ts'],
        note: 'Reviewed: consolidation candidate.',
      },
      {
        name: 'Gone',
        kind: 'collision',
        files: ['src/c.ts', 'src/d.ts'],
        note: 'Reviewed: rename pending.',
      },
    ],
  };

  it('matches findings that agree with the baseline', () => {
    const comparison = compareFindingsToBaseline(baseline, [{
      name: 'Same',
      classification: 'identical',
      declarationKinds: ['type'],
      files: ['src/a.ts', 'src/b.ts'],
    }]);

    expect(comparison.matchedCount).toBe(1);
    expect(comparison.newFindings).toEqual([]);
    expect(comparison.kindChanges).toEqual([]);
    expect(comparison.fileChanges).toEqual([]);
    expect(comparison.staleEntries.map(entry => entry.name)).toEqual(['Gone']);
  });

  it('reports new findings, worsened classifications, and footprint changes', () => {
    const comparison = compareFindingsToBaseline(baseline, [
      {
        name: 'Same',
        classification: 'collision',
        declarationKinds: ['type'],
        files: ['src/a.ts', 'src/b.ts'],
      },
      {
        name: 'Fresh',
        classification: 'identical',
        declarationKinds: ['interface'],
        files: ['src/e.ts', 'src/f.ts'],
      },
    ]);

    expect(comparison.kindChanges).toEqual([{
      name: 'Same',
      baselineKind: 'identical',
      currentKind: 'collision',
    }]);
    expect(comparison.newFindings.map(finding => finding.name)).toEqual(['Fresh']);

    const footprint = compareFindingsToBaseline(baseline, [{
      name: 'Same',
      classification: 'identical',
      declarationKinds: ['type'],
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    }]);
    expect(footprint.fileChanges).toEqual([{
      name: 'Same',
      added: ['src/c.ts'],
      removed: [],
    }]);
  });
});

describe('buildUpdatedBaseline', () => {
  const baseline: DuplicateTypeBaseline = {
    schemaVersion: 1,
    entries: [
      {
        name: 'Same',
        kind: 'identical',
        files: ['src/a.ts', 'src/b.ts'],
        note: 'Reviewed: consolidation candidate.',
      },
      {
        name: 'Resolved',
        kind: 'collision',
        files: ['src/c.ts', 'src/d.ts'],
        note: 'Reviewed: consolidated away.',
      },
    ],
  };

  it('carries notes forward and drops resolved entries', () => {
    const result = buildUpdatedBaseline(baseline, [{
      name: 'Same',
      classification: 'identical',
      declarationKinds: ['type'],
      files: ['src/a.ts', 'src/b.ts'],
    }]);

    expect(result.refusals).toEqual([]);
    expect(result.removedNames).toEqual(['Resolved']);
    expect(result.baseline.entries).toEqual([{
      name: 'Same',
      kind: 'identical',
      files: ['src/a.ts', 'src/b.ts'],
      note: 'Reviewed: consolidation candidate.',
    }]);
  });

  it('refuses new names, identical-to-collision upgrades, and spreading footprints', () => {
    const result = buildUpdatedBaseline(baseline, [
      {
        name: 'Same',
        classification: 'collision',
        declarationKinds: ['type'],
        files: ['src/a.ts', 'src/b.ts', 'src/e.ts'],
      },
      {
        name: 'Fresh',
        classification: 'identical',
        declarationKinds: ['interface'],
        files: ['src/e.ts', 'src/f.ts'],
      },
      {
        name: 'Resolved',
        classification: 'collision',
        declarationKinds: ['interface', 'type'],
        files: ['src/c.ts', 'src/d.ts'],
      },
    ]);

    expect(result.refusals).toHaveLength(2);
    expect(result.refusals[0]).toMatch(/"Same" worsened from identical to collision/u);
    expect(result.refusals[1]).toMatch(/"Fresh" .* is new/u);
    expect(result.baseline.entries).toEqual([baseline.entries[1]]);
  });

  it('accepts footprint reductions and collision-to-identical improvements', () => {
    const result = buildUpdatedBaseline({
      schemaVersion: 1,
      entries: [{
        name: 'Pair',
        kind: 'collision',
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        note: 'Reviewed: rename pending.',
      }],
    }, [{
      name: 'Pair',
      classification: 'identical',
      declarationKinds: ['type'],
      files: ['src/a.ts', 'src/b.ts'],
    }]);

    expect(result.refusals).toEqual([]);
    expect(result.rewrittenNames).toEqual(['Pair']);
    expect(result.baseline.entries[0]).toEqual({
      name: 'Pair',
      kind: 'identical',
      files: ['src/a.ts', 'src/b.ts'],
      note: 'Reviewed: rename pending.',
    });
  });
});
