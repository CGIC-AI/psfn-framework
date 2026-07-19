import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptManager } from '../../core/identity/prompt-manager.js';
import { PromptLayerStore } from '../../core/identity/prompt-store.js';
import {
  backfillPromptLayerIdentifiers,
  formatPromptLayerIdentifierBackfillReport,
} from './prompt-layer-identifier-backfill.js';

const FIXTURE = `[
  {
    "id": "legacy-base",
    "type": "base",
    "name": "Legacy Base",
    "content": "BASE",
    "enabled": true,
    "priority": 0,
    "updatedAt": "2026-07-19T12:00:00.000Z",
    "updatedBy": "fixture",
    "checksum": "cbf36a964ba8c089",
    "version": 1,
    "unknown": { "preserve": ["exact", 2] }
  },
  {
    "id": "identified-base",
    "type": "base",
    "identifier": "scenario",
    "name": "Identified Base",
    "content": "SCENARIO",
    "enabled": true,
    "priority": 1,
    "updatedAt": "2026-07-19T12:00:00.000Z",
    "updatedBy": "fixture",
    "checksum": "545f1631a99fe78e",
    "version": 1
  },
  {
    "id": "legacy-runtime",
    "type": "runtime",
    "name": "Legacy Runtime",
    "content": "RUNTIME",
    "enabled": true,
    "priority": 2,
    "updatedAt": "2026-07-19T12:00:00.000Z",
    "updatedBy": "fixture",
    "checksum": "645e4fc5442ea826",
    "version": 1
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

  it('fails without rewriting when the target file is missing or stored records are malformed', () => {
    const layersPath = createFixture();
    const missingPath = join(layersPath, 'missing');

    expect(() => backfillPromptLayerIdentifiers({ layersPath: missingPath }))
      .toThrow(`Prompt layers file does not exist: ${missingPath}`);

    const malformedFixture = '[{"type":"base"}]';
    writeFileSync(layersPath, malformedFixture, 'utf8');
    expect(() => backfillPromptLayerIdentifiers({ layersPath, apply: true }))
      .toThrow('layers[0].id must be a non-empty string');
    expect(readFileSync(layersPath, 'utf8')).toBe(malformedFixture);
  });

  it('refuses ambiguous multiple legacy bases instead of collapsing their composition', () => {
    const layersPath = createFixture();
    const ambiguousFixture = FIXTURE.replace('    "identifier": "scenario",\n', '');
    writeFileSync(layersPath, ambiguousFixture, 'utf8');

    expect(() => backfillPromptLayerIdentifiers({ layersPath, apply: true }))
      .toThrow('the legacy composer assigned "main" only to the first');
    expect(readFileSync(layersPath, 'utf8')).toBe(ambiguousFixture);
  });

  it('reproduces the captured legacy-main composition after running the backfill', () => {
    const layersPath = createFixture();
    backfillPromptLayerIdentifiers({ layersPath, apply: true });
    const store = new PromptLayerStore(layersPath, join(layersPath, '..', 'prompt-history.jsonl'));

    const result = new PromptManager().compose(store.getAll());

    // Captured from the old usedLegacyMain coercion over this fixture.
    expect({
      text: result.text,
      prompts: result.prompts.map(prompt => ({
        content: prompt.content,
        identifier: prompt.identifier,
        sourceLayerId: prompt.sourceLayerId,
      })),
      autoHealedIdentifiers: result.autoHealedIdentifiers,
    }).toEqual({
      text: 'BASE\n\nSCENARIO\n\nRUNTIME',
      prompts: [
        { content: 'BASE', identifier: 'main', sourceLayerId: 'legacy-base' },
        { content: 'SCENARIO', identifier: 'scenario', sourceLayerId: 'identified-base' },
        { content: 'RUNTIME', identifier: 'layer:legacy-runtime', sourceLayerId: 'legacy-runtime' },
      ],
      autoHealedIdentifiers: [
        'charDescription',
        'charPersonality',
        'dialogueExamples',
        'postHistoryInstructions',
      ],
    });
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
