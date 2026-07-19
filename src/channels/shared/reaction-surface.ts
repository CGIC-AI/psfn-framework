// ── Curated reaction surface (jp36.3.1.2) ──
// Pure, dependency-free model for the emoji reactions a companion may use as a
// first-class social action (design bible §8.3, adjudication S6.1). The surface
// is a curated subset of standard emojis (the ones people actually use, each
// carrying a one-line meaning) PLUS guild-custom emojis that an operator has
// loaded with a one-line meaning description so the companion can use house
// memes correctly.
//
// Fail-closed inclusion rule: a guild-custom emoji is surfaced ONLY when it is
// (a) present and usable in the guild AND (b) has a non-empty configured
// meaning. A guild-custom emoji with no configured meaning is "unknown" and is
// excluded — the companion is never shown a house meme it cannot interpret.
//
// This module has no runtime dependencies so it can be imported by channel
// adapters (which resolve live guild emojis) and by the agent runtime-context
// section producer (which renders the surface into the prompt) without creating
// a layering cycle.

/** A curated standard-emoji reaction with a one-line meaning. */
export interface StandardReactionEntry {
  /** The unicode emoji used verbatim as the reaction token. */
  readonly emoji: string;
  /** One-line meaning shown to the companion. */
  readonly meaning: string;
}

/**
 * A guild-custom emoji as observed in a Discord guild (from
 * `guild.emojis.cache`). `available` is `false` when the emoji is currently
 * unusable (e.g. a lost server-boost tier); such emojis are excluded.
 */
export interface GuildCustomEmoji {
  readonly name: string;
  readonly id: string;
  readonly animated: boolean;
  readonly available: boolean;
}

/** A resolved guild-custom emoji that carries a configured one-line meaning. */
export interface ResolvedCustomReactionEntry {
  readonly name: string;
  /** Discord reaction token: `name:id` (or `a:name:id` when animated). */
  readonly token: string;
  readonly meaning: string;
}

/** The curated reaction surface available for a turn. */
export interface ResolvedReactionSurface {
  readonly standard: readonly StandardReactionEntry[];
  readonly custom: readonly ResolvedCustomReactionEntry[];
}

/** Configured one-line meanings for one guild's custom emojis, keyed by name. */
export type CustomEmojiMeanings = Readonly<Record<string, string>>;

/** channels.json shape: per-guild custom-emoji meanings, keyed by guild id. */
export type CustomEmojiMeaningsByGuild = Readonly<Record<string, CustomEmojiMeanings>>;

/**
 * Curated subset of standard emojis — the ones people actually use as
 * reactions — each with a one-line meaning. Object-literal curated data
 * (a taxonomy, not a tuning knob), so it is code-owned.
 */
export const STANDARD_REACTION_SUBSET: readonly StandardReactionEntry[] = [
  { emoji: '👍', meaning: 'agreement, approval, acknowledgement' },
  { emoji: '👎', meaning: 'disagreement or disapproval' },
  { emoji: '❤️', meaning: 'love, strong appreciation, care' },
  { emoji: '🫶', meaning: 'warm affection or gratitude' },
  { emoji: '🔥', meaning: 'this is excellent or impressive' },
  { emoji: '🎉', meaning: 'celebration or congratulations' },
  { emoji: '😂', meaning: 'found it very funny' },
  { emoji: '😄', meaning: 'happy, amused, warm' },
  { emoji: '🙂', meaning: 'mild positive acknowledgement' },
  { emoji: '😅', meaning: 'awkward or relieved amusement' },
  { emoji: '🤔', meaning: 'thinking it over, uncertain or skeptical' },
  { emoji: '👀', meaning: 'noticing, watching, intrigued' },
  { emoji: '😮', meaning: 'surprise' },
  { emoji: '😢', meaning: 'sadness or sympathy' },
  { emoji: '🥺', meaning: 'tender, pleading, moved' },
  { emoji: '🙏', meaning: 'thanks or please' },
  { emoji: '🤝', meaning: 'agreement reached, deal, solidarity' },
  { emoji: '✅', meaning: 'done, correct, confirmed' },
  { emoji: '💯', meaning: 'full agreement, exactly right' },
  { emoji: '👋', meaning: 'greeting or farewell' },
] as const;

/**
 * Build the curated reaction surface for a turn. The standard subset is always
 * available. Guild-custom emojis are included only when present/usable in the
 * guild AND carrying a non-empty configured meaning; unknown custom emojis are
 * excluded (adjudication S6.1).
 */
export function buildReactionSurface(input: {
  readonly guildCustomEmojis: readonly GuildCustomEmoji[];
  readonly customEmojiMeanings: CustomEmojiMeanings;
  readonly standardSubset?: readonly StandardReactionEntry[];
}): ResolvedReactionSurface {
  const standard = input.standardSubset ?? STANDARD_REACTION_SUBSET;
  const seenIds = new Set<string>();
  const custom: ResolvedCustomReactionEntry[] = [];

  for (const emoji of input.guildCustomEmojis) {
    const name = typeof emoji.name === 'string' ? emoji.name.trim() : '';
    const id = typeof emoji.id === 'string' ? emoji.id.trim() : '';
    if (!name || !id) continue; // malformed guild emoji — cannot form a react token
    if (emoji.available === false) continue; // unusable in this guild
    const rawMeaning = input.customEmojiMeanings[name];
    const meaning = typeof rawMeaning === 'string' ? rawMeaning.trim() : '';
    if (!meaning) continue; // unknown custom emoji — excluded
    if (seenIds.has(id)) continue; // dedup by emoji id
    seenIds.add(id);
    custom.push({
      name,
      token: `${emoji.animated ? 'a:' : ''}${name}:${id}`,
      meaning,
    });
  }

  return { standard, custom };
}

/** True when the surface carries no reactions at all (renders nothing). */
export function reactionSurfaceIsEmpty(surface: ResolvedReactionSurface): boolean {
  return surface.standard.length === 0 && surface.custom.length === 0;
}

const MAX_GUILDS = 512;
const MAX_MEANINGS_PER_GUILD = 512;
const MAX_MEANING_CHARS = 200;
const CUSTOM_EMOJI_NAME_PATTERN = /^[A-Za-z0-9_]{2,32}$/;

/**
 * Fail-closed normalization of the channels.json per-guild custom-emoji
 * meanings map. Rejects malformed shapes, unusable emoji names, empty or
 * over-long meanings, and enforces bounded sizes. An absent section yields an
 * empty map (no custom meanings configured).
 */
export function normalizeCustomEmojiMeanings(
  value: unknown,
  fieldPath: string,
): Record<string, CustomEmojiMeanings> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an object mapping guild id to emoji meanings`);
  }
  const guildEntries = Object.entries(value as Record<string, unknown>);
  if (guildEntries.length > MAX_GUILDS) {
    throw new Error(`${fieldPath} must not declare more than ${MAX_GUILDS} guilds`);
  }
  const result: Record<string, CustomEmojiMeanings> = {};
  for (const [guildId, guildValue] of guildEntries) {
    const guildPath = `${fieldPath}.${guildId}`;
    const trimmedGuildId = guildId.trim();
    if (!trimmedGuildId) {
      throw new Error(`${guildPath} guild id must not be blank`);
    }
    if (typeof guildValue !== 'object' || guildValue === null || Array.isArray(guildValue)) {
      throw new Error(`${guildPath} must be an object mapping emoji name to meaning`);
    }
    const meaningEntries = Object.entries(guildValue as Record<string, unknown>);
    if (meaningEntries.length > MAX_MEANINGS_PER_GUILD) {
      throw new Error(
        `${guildPath} must not declare more than ${MAX_MEANINGS_PER_GUILD} emoji meanings`,
      );
    }
    const meanings: Record<string, string> = {};
    for (const [emojiName, meaningValue] of meaningEntries) {
      const namePath = `${guildPath}.${emojiName}`;
      if (!CUSTOM_EMOJI_NAME_PATTERN.test(emojiName)) {
        throw new Error(
          `${namePath} must be a valid custom-emoji name (2-32 chars, letters/digits/underscore)`,
        );
      }
      if (typeof meaningValue !== 'string') {
        throw new Error(`${namePath} meaning must be a string`);
      }
      const meaning = meaningValue.trim();
      if (!meaning) {
        throw new Error(`${namePath} meaning must not be blank`);
      }
      if (meaning.length > MAX_MEANING_CHARS) {
        throw new Error(`${namePath} meaning must be at most ${MAX_MEANING_CHARS} characters`);
      }
      meanings[emojiName] = meaning;
    }
    result[trimmedGuildId] = meanings;
  }
  return result;
}
