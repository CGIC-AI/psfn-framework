import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backfillPromptLayerIdentifiers,
  formatPromptLayerIdentifierBackfillReport,
} from './backfill-prompt-layer-identifiers.js';

const FIXTURE = `[
  {
    "id": "legacy-base",
    "type": "base",
    "name": "Legacy Base",
    "content": "BASE",
    "unknown": { "preserve": ["exact", 2] }
  },
  {
    "id": "identified-base",
    "type": "base",
    "identifier": "scenario",
    "name": "Identified Base",
    "content": "SCENARIO"
  },
  {
    "id": "legacy-runtime",
    "type": "runtime",
    "name": "Legacy Runtime",
    "content": "RUNTIME"
  }
]`;

describe('prompt layer identifier backfill', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const scratchDir of scratchDirs) {
      rmSync(scratchDir, { force: true, recursive: true });
    }
    scratchDirs.length = 0;
  });

  function createFixture(): string {
    const scratchDir = mkdtempSync(join(tmpdir(), 'psfn-prompt-layer-identifiers-'));
    scratchDirs.push(scratchDir);
    const layersPath = join(scratchDir, 'prompt-layers.json');
    writeFileSync(layersPath, FIXTURE, 'utf8');
    return layersPath;
  }

  it('reports identifier-less base layers without changing the file in dry-run mode', () => {
    const layersPath = createFixture();

    const report = backfillPromptLayerIdentifiers({ layersPath, apply: false });

    expect(formatPromptLayerIdentifierBackfillReport(report)).toEqual([
      'Mode: dry-run',
      `Prompt layers file: ${layersPath}`,
      'Scanned layers: 3',
      'Identifier-less base layers: 1',
      'Updated: 0',
      `- ${layersPath}#layers[0] id=legacy-base name="Legacy Base" identifier=main status=would-update`,
    ]);
    expect(readFileSync(layersPath, 'utf8')).toBe(FIXTURE);
  });

  it('adds only the missing identifier bytes and is idempotent', () => {
    const layersPath = createFixture();
    const expected = FIXTURE.replace(
      '    "id": "legacy-base",',
      '    "identifier": "main",\n    "id": "legacy-base",',
    );

    const applied = backfillPromptLayerIdentifiers({ layersPath, apply: true });

    expect(applied).toMatchObject({
      mode: 'apply',
      scannedLayers: 3,
      identifierLessBaseLayers: 1,
      updated: 1,
    });
    expect(readFileSync(layersPath, 'utf8')).toBe(expected);

    const secondRun = backfillPromptLayerIdentifiers({ layersPath, apply: true });

    expect(secondRun).toMatchObject({
      mode: 'apply',
      scannedLayers: 3,
      identifierLessBaseLayers: 0,
      updated: 0,
      entries: [],
    });
    expect(readFileSync(layersPath, 'utf8')).toBe(expected);
  });

  it('fails without rewriting when an identifier field exists but is invalid', () => {
    const layersPath = createFixture();
    const invalidFixture = FIXTURE.replace(
      '    "type": "base",',
      '    "type": "base",\n    "identifier": "   ",',
    );
    writeFileSync(layersPath, invalidFixture, 'utf8');

    expect(() => backfillPromptLayerIdentifiers({ layersPath, apply: true }))
      .toThrow('has an identifier field that is not a non-empty string');
    expect(readFileSync(layersPath, 'utf8')).toBe(invalidFixture);
  });

  it('is exposed through the exact package script named by the failure message', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['migrate:prompt-layer-identifiers']).toBe(
      'tsx src/app/maintenance/backfill-prompt-layer-identifiers.ts',
    );
  });
});
