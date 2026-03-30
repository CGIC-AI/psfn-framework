import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveCompanionIdFromConfig,
  resolveCompanionNameFromCard,
  resolveCompanionNameFromConfig,
} from './companion-runtime.js';
import type { CharacterCardV2 } from './types.js';

const TEST_CARD: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Lyra',
    description: 'Test identity.',
    personality: 'Direct and warm.',
    scenario: 'Unit test scenario.',
    first_mes: 'Hello.',
    mes_example: '',
    creator: 'system',
    tags: [],
  },
};

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-companion-runtime-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('resolveCompanionNameFromCard', () => {
  it('returns the explicit companion name from the card', () => {
    expect(resolveCompanionNameFromCard(TEST_CARD)).toBe('Lyra');
  });

  it('throws when the card is missing explicit identity data', () => {
    expect(() => resolveCompanionNameFromCard(null)).toThrow(
      'Missing companion name from character card: explicit identity is required',
    );
  });
});

describe('resolveCompanionNameFromConfig', () => {
  it('returns the configured character name when no card path is set', () => {
    expect(resolveCompanionNameFromConfig({ characterName: 'Lyra' })).toBe('Lyra');
  });

  it('loads the card name when a card path is set', () => {
    const root = makeTempDir();
    const path = join(root, 'companion.json');
    writeFileSync(path, `${JSON.stringify(TEST_CARD, null, 2)}\n`, 'utf-8');

    expect(resolveCompanionNameFromConfig({
      characterCardPath: path,
      characterName: 'Fallback',
    })).toBe('Lyra');
  });

  it('throws when configured identity is missing', () => {
    expect(() => resolveCompanionNameFromConfig({})).toThrow(
      'Missing companion name from configured character name: explicit identity is required',
    );
  });

  it('seeds a bootstrap card when the configured companion file is missing', () => {
    const root = makeTempDir();
    const path = join(root, 'companion.json');

    expect(resolveCompanionNameFromConfig({
      characterCardPath: path,
    })).toBe('Companion');
  });
});

describe('resolveCompanionIdFromConfig', () => {
  it('defaults to the canonical companion id when unset', () => {
    expect(resolveCompanionIdFromConfig({})).toBe('companion');
  });
});
