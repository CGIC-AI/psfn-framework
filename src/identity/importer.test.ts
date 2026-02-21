import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { parseCard } from '@character-foundry/character-foundry/loader';
import { exportCard } from '@character-foundry/character-foundry/exporter';
import type { CharacterCardV2 } from './types.js';
import {
  importCharacterCardFromPath,
  importCharacterCardToPath,
  normalizeImportedCard,
} from './importer.js';

const TEST_CARD_V2: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Importer Test',
    description: 'A card used for importer tests.',
    personality: 'Friendly and pragmatic.',
    scenario: 'Testing parser auto-detection.',
    first_mes: 'Hi there.',
    mes_example: '{{user}}: hello\n{{char}}: hi',
    system_prompt: 'Always be concise.',
    post_history_instructions: 'Keep continuity.',
    tags: ['tests', 'identity'],
    creator: 'test-suite',
    creator_notes: 'metadata should survive when available',
  },
};

const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5P4T0AAAAASUVORK5CYII=',
  'base64',
);

function toV3Card() {
  return parseCard(Buffer.from(JSON.stringify(TEST_CARD_V2), 'utf-8')).card;
}

describe('character importer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'character-importer-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes parsed cards to the runtime v2 card shape', () => {
    const v3 = toV3Card();
    const normalized = normalizeImportedCard(v3);

    expect(normalized.spec).toBe('chara_card_v2');
    expect(normalized.spec_version).toBe('2.0');
    expect(normalized.data.name).toBe('Importer Test');
    expect(normalized.data.personality).toBe('Friendly and pragmatic.');
    expect(normalized.data.system_prompt).toBe('Always be concise.');
    expect(normalized.data.creator_notes).toBe('metadata should survive when available');
  });

  it('imports JSON cards via auto-detect parser', () => {
    const sourcePath = join(tempDir, 'source-card.json');
    writeFileSync(sourcePath, JSON.stringify(toV3Card()), 'utf-8');

    const result = importCharacterCardFromPath(sourcePath);
    expect(result.containerFormat).toBe('json');
    expect(result.spec).toBe('v3');
    expect(result.card.data.name).toBe('Importer Test');
  });

  it('imports PNG cards via auto-detect parser', () => {
    const sourcePath = join(tempDir, 'source-card.png');
    const pngResult = exportCard(
      toV3Card(),
      [{ name: 'icon-main', type: 'icon', ext: 'png', data: ONE_BY_ONE_PNG, isMain: true }],
      { format: 'png' },
    );
    writeFileSync(sourcePath, pngResult.buffer);

    const result = importCharacterCardFromPath(sourcePath);
    expect(result.containerFormat).toBe('png');
    expect(result.card.data.name).toBe('Importer Test');
  });

  it('imports CharX cards via auto-detect parser', () => {
    const sourcePath = join(tempDir, 'source-card.charx');
    const charxResult = exportCard(toV3Card(), [], { format: 'charx' });
    writeFileSync(sourcePath, charxResult.buffer);

    const result = importCharacterCardFromPath(sourcePath);
    expect(result.containerFormat).toBe('charx');
    expect(result.card.data.name).toBe('Importer Test');
  });

  it('writes imported cards to destination path as runtime v2 JSON', () => {
    const sourcePath = join(tempDir, 'source-write.json');
    writeFileSync(sourcePath, JSON.stringify(TEST_CARD_V2), 'utf-8');
    const destinationPath = join(tempDir, 'nested', 'character.json');

    const result = importCharacterCardToPath(sourcePath, destinationPath);
    const written = JSON.parse(readFileSync(destinationPath, 'utf-8')) as CharacterCardV2;

    expect(result.destinationPath).toBe(destinationPath);
    expect(written.spec).toBe('chara_card_v2');
    expect(written.data.name).toBe('Importer Test');
    expect(written.data.personality).toBe('Friendly and pragmatic.');
  });
});
