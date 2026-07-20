import { describe, expect, it } from 'vitest';
import {
  STANDARD_REACTION_SUBSET,
  buildReactionSurface,
  normalizeCustomEmojiMeanings,
  reactionSurfaceIsEmpty,
  type GuildCustomEmoji,
} from './reaction-surface.js';

function emoji(overrides: Partial<GuildCustomEmoji> & Pick<GuildCustomEmoji, 'name' | 'id'>): GuildCustomEmoji {
  return { animated: false, available: true, ...overrides };
}

describe('buildReactionSurface (jp36.3.1.2)', () => {
  it('always includes the curated standard subset with meanings', () => {
    const surface = buildReactionSurface({ guildCustomEmojis: [], customEmojiMeanings: {} });
    expect(surface.standard).toBe(STANDARD_REACTION_SUBSET);
    expect(surface.standard.length).toBeGreaterThan(0);
    for (const entry of surface.standard) {
      expect(entry.emoji.trim().length).toBeGreaterThan(0);
      expect(entry.meaning.trim().length).toBeGreaterThan(0);
    }
    expect(surface.custom).toEqual([]);
  });

  it('includes a guild-custom emoji only when it carries a configured meaning', () => {
    const surface = buildReactionSurface({
      guildCustomEmojis: [
        emoji({ name: 'blobwave', id: '111' }),
        emoji({ name: 'mystery', id: '222' }),
      ],
      customEmojiMeanings: { blobwave: 'the house greeting meme' },
    });
    expect(surface.custom).toEqual([
      { name: 'blobwave', token: 'blobwave:111', meaning: 'the house greeting meme' },
    ]);
  });

  it('excludes unknown custom emoji (no configured meaning), per adjudication S6.1', () => {
    const surface = buildReactionSurface({
      guildCustomEmojis: [emoji({ name: 'mystery', id: '999' })],
      customEmojiMeanings: {},
    });
    expect(surface.custom).toEqual([]);
  });

  it('excludes custom emoji whose configured meaning is blank', () => {
    const surface = buildReactionSurface({
      guildCustomEmojis: [emoji({ name: 'blank', id: '1' })],
      customEmojiMeanings: { blank: '   ' },
    });
    expect(surface.custom).toEqual([]);
  });

  it('excludes emoji that are unavailable in the guild (e.g. lost boost tier)', () => {
    const surface = buildReactionSurface({
      guildCustomEmojis: [emoji({ name: 'boosted', id: '5', available: false })],
      customEmojiMeanings: { boosted: 'premium meme' },
    });
    expect(surface.custom).toEqual([]);
  });

  it('marks animated custom emoji with the a: token prefix', () => {
    const surface = buildReactionSurface({
      guildCustomEmojis: [emoji({ name: 'party', id: '42', animated: true })],
      customEmojiMeanings: { party: 'celebration meme' },
    });
    expect(surface.custom[0]?.token).toBe('a:party:42');
  });

  it('deduplicates custom emoji by id and skips malformed entries', () => {
    const surface = buildReactionSurface({
      guildCustomEmojis: [
        emoji({ name: 'dup', id: '7' }),
        emoji({ name: 'dup', id: '7' }),
        emoji({ name: '', id: '8' }),
        emoji({ name: 'noid', id: '' }),
      ],
      customEmojiMeanings: { dup: 'a meme', noid: 'unusable' },
    });
    expect(surface.custom).toEqual([{ name: 'dup', token: 'dup:7', meaning: 'a meme' }]);
  });

  it('reactionSurfaceIsEmpty reflects an empty custom+standard surface', () => {
    expect(reactionSurfaceIsEmpty({ standard: [], custom: [] })).toBe(true);
    expect(reactionSurfaceIsEmpty({ standard: STANDARD_REACTION_SUBSET, custom: [] })).toBe(false);
  });
});

describe('normalizeCustomEmojiMeanings (jp36.3.1.2)', () => {
  it('returns an empty map for an absent section', () => {
    expect(normalizeCustomEmojiMeanings(undefined, 'x')).toEqual({});
    expect(normalizeCustomEmojiMeanings(null, 'x')).toEqual({});
  });

  it('normalizes a per-guild meaning map and trims meanings', () => {
    const result = normalizeCustomEmojiMeanings(
      { '123456': { blobwave: '  the house greeting meme  ' } },
      'channels.json.discord.customEmojiMeanings',
    );
    expect(result).toEqual({ '123456': { blobwave: 'the house greeting meme' } });
  });

  it('rejects a non-object top-level value', () => {
    expect(() => normalizeCustomEmojiMeanings([], 'x')).toThrow(/must be an object/);
    expect(() => normalizeCustomEmojiMeanings('nope', 'x')).toThrow(/must be an object/);
  });

  it('rejects a non-object guild value', () => {
    expect(() => normalizeCustomEmojiMeanings({ '1': 'nope' }, 'x')).toThrow(/emoji name to meaning/);
  });

  it('rejects an invalid emoji name', () => {
    expect(() => normalizeCustomEmojiMeanings({ '1': { 'bad name!': 'm' } }, 'x'))
      .toThrow(/valid custom-emoji name/);
  });

  it('rejects a blank or non-string meaning', () => {
    expect(() => normalizeCustomEmojiMeanings({ '1': { ok: '   ' } }, 'x')).toThrow(/must not be blank/);
    expect(() => normalizeCustomEmojiMeanings({ '1': { ok: 5 } }, 'x')).toThrow(/must be a string/);
  });

  it('rejects an over-long meaning', () => {
    const longMeaning = 'x'.repeat(201);
    expect(() => normalizeCustomEmojiMeanings({ '1': { ok: longMeaning } }, 'x'))
      .toThrow(/at most 200 characters/);
  });
});
