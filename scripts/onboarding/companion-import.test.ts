import { describe, expect, it } from 'vitest';
import { parseCard } from '@character-foundry/character-foundry/loader';
import type { CharacterCardV2 } from '../../src/core/identity/types.js';
import { assertValidCharacterCard } from '../../src/core/identity/loader.js';
import {
  CompanionImportError,
  detectCompanionFormat,
  freshStart,
  importCcv3,
  importMarkdownLump,
  importSoulMd,
  suggestLumpName,
} from './companion-import.js';

const CCV3_CARD: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Nova',
    description: 'A curious deep-space guide.',
    personality: 'Warm, inquisitive, precise.',
    scenario: 'Aboard a survey vessel.',
    first_mes: 'Hi, I am Nova.',
    mes_example: '',
    system_prompt: 'Stay grounded and specific.',
    post_history_instructions: '',
    tags: ['space'],
    creator: 'tester',
  },
};

function ccv3Bytes(card: CharacterCardV2 = CCV3_CARD): Uint8Array {
  // Round-trip through the foundry loader so the bytes are a genuine v3-normalizable card.
  const v3 = parseCard(Buffer.from(JSON.stringify(card), 'utf-8')).card;
  return Buffer.from(JSON.stringify(v3), 'utf-8');
}

describe('companion-import: Character Card V3', () => {
  it('imports a CCv3 JSON card through the existing importer pathway', () => {
    const result = importCcv3(ccv3Bytes());
    expect(result.source).toBe('ccv3');
    expect(result.card.spec).toBe('chara_card_v2');
    expect(result.card.data.name).toBe('Nova');
    expect(result.card.data.personality).toBe('Warm, inquisitive, precise.');
    expect(() => assertValidCharacterCard(result.card)).not.toThrow();
  });

  it('surfaces a lorebook warning instead of silently dropping character_book entries', () => {
    const v3 = parseCard(Buffer.from(JSON.stringify(CCV3_CARD), 'utf-8')).card as unknown as {
      data: Record<string, unknown>;
    };
    v3.data.character_book = {
      entries: [{ content: 'The vessel is named Meridian.', keys: ['ship'], enabled: true, insertion_order: 1 }],
    };
    const result = importCcv3(Buffer.from(JSON.stringify(v3), 'utf-8'));
    expect(result.memorySeeds).toHaveLength(1);
    expect(result.warnings.some((w) => /lorebook/i.test(w))).toBe(true);
  });

  it('rejects non-card JSON with a specific error before anything is produced', () => {
    expect(() => importCcv3(Buffer.from('{"totally":"not a card"}', 'utf-8')))
      .toThrow(CompanionImportError);
  });
});

describe('companion-import: SoulMD', () => {
  const SOUL_DOC = [
    '---',
    'name: Sable',
    'creator: operator',
    'tags: [companion, noir]',
    '---',
    '',
    '## Personality',
    'Dry wit, fiercely loyal, allergic to small talk.',
    '',
    '## Scenario',
    'A rain-soaked city that never sleeps.',
    '',
    '## First Message',
    'You again. Sit down, tell me what you need.',
    '',
    '## Field Notes',
    'Keeps a battered notebook of everyone she has ever helped.',
    '',
  ].join('\n');

  it('maps frontmatter + headed sections onto the card fields', () => {
    const result = importSoulMd(SOUL_DOC);
    expect(result.source).toBe('soulmd');
    expect(result.card.data.name).toBe('Sable');
    expect(result.card.data.creator).toBe('operator');
    expect(result.card.data.tags).toEqual(['companion', 'noir']);
    expect(result.card.data.personality).toContain('Dry wit');
    expect(result.card.data.scenario).toContain('rain-soaked');
    expect(result.card.data.first_mes).toContain('Sit down');
    // Unknown "Field Notes" section is preserved in the profile, not dropped.
    expect(result.card.data.description).toContain('battered notebook');
    expect(result.warnings.some((w) => /unrecognized section/i.test(w))).toBe(true);
    expect(() => assertValidCharacterCard(result.card)).not.toThrow();
  });

  it('accepts a top-level "# Name" heading when no frontmatter name is present', () => {
    const doc = '# Atlas\n\n## Personality\nSteady and reassuring.\n';
    const result = importSoulMd(doc);
    expect(result.card.data.name).toBe('Atlas');
    expect(result.card.data.personality).toBe('Steady and reassuring.');
  });

  it('falls back to the description for personality when only a Description section exists', () => {
    const doc = '# Echo\n\n## Description\nA quiet archivist who remembers everything.\n';
    const result = importSoulMd(doc);
    expect(result.card.data.personality).toBe('A quiet archivist who remembers everything.');
    expect(result.warnings.some((w) => /persona/i.test(w))).toBe(true);
  });

  it('rejects a SoulMD document with no name', () => {
    expect(() => importSoulMd('## Personality\nNo name anywhere.\n')).toThrow(CompanionImportError);
  });

  it('rejects a SoulMD document with no persona content', () => {
    expect(() => importSoulMd('---\nname: Ghost\n---\n')).toThrow(/no recognizable persona content/i);
  });
});

describe('companion-import: plain persona markdown (lump)', () => {
  const LUMP = '# Rune\n\nYou are Rune, a hearth-keeper. You speak plainly, you keep promises, '
    + 'and you notice when someone is tired before they say so.\n\n## Habits\nTends a small fire.\n';

  it('imports the whole document as one persona lump without field sorting', () => {
    const result = importMarkdownLump(LUMP, 'Rune');
    expect(result.source).toBe('markdown');
    expect(result.card.data.name).toBe('Rune');
    // The full document (including its headings) lands as a single lump.
    expect(result.card.data.personality).toContain('# Rune');
    expect(result.card.data.personality).toContain('## Habits');
    // Fields are NOT split out of the markdown.
    expect(result.card.data.scenario).toBe('');
    expect(result.card.data.description).toBe('');
    expect(() => assertValidCharacterCard(result.card)).not.toThrow();
  });

  it('suggests a name from the first H1, else the filename stem', () => {
    expect(suggestLumpName(LUMP, '/tmp/whatever.md')).toBe('Rune');
    expect(suggestLumpName('no heading here', '/tmp/my-buddy.md')).toBe('my-buddy');
  });

  it('rejects an empty persona file and a missing name', () => {
    expect(() => importMarkdownLump('   \n  ', 'Rune')).toThrow(/empty/i);
    expect(() => importMarkdownLump(LUMP, '   ')).toThrow(/name is required/i);
  });
});

describe('companion-import: fresh start', () => {
  it('scaffolds a minimal valid blank companion', () => {
    const result = freshStart('Willow');
    expect(result.source).toBe('fresh');
    expect(result.card.data.name).toBe('Willow');
    expect(result.card.data.tags).toContain('bootstrap');
    expect(() => assertValidCharacterCard(result.card)).not.toThrow();
  });

  it('defaults the name when none is provided', () => {
    expect(freshStart('   ').card.data.name).toBe('Companion');
  });
});

describe('companion-import: format detection (advisory)', () => {
  it('detects JSON/PNG cards, SoulMD, and plain markdown', () => {
    expect(detectCompanionFormat('card.json', Buffer.from('{"spec":"chara_card_v3"}'))).toBe('ccv3');
    expect(detectCompanionFormat('card.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('ccv3');
    expect(detectCompanionFormat('soul.md', Buffer.from('---\nname: X\n---\n## Personality\nHi'))).toBe('soulmd');
    expect(detectCompanionFormat('persona.md', Buffer.from('just a plain paragraph of persona text'))).toBe('markdown');
  });
});
