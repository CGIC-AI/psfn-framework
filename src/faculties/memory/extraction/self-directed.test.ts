import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import type { ExtractedFact } from '../types.js';
import { normalizeExperientialSelfDirectedFact } from './self-directed.js';

const CHANNEL_ID = 'internal:free-time:idle';
const COMPANION_NAME = 'Purrsephone';
const GENUINE_FEELING = 'I felt unexpectedly calm while painting the blue wash.';
const STYLE_PREFERENCE = 'I dislike polished symmetry; I prefer loose watercolor edges because they feel alive.';

const entries: SessionEntry[] = [
  {
    id: 1,
    channelId: CHANNEL_ID,
    role: 'user',
    authorId: 'scheduler',
    authorName: 'Free Time',
    content: 'I feel delighted that you have free time to explore painting.',
    timestamp: 1_000,
  },
  {
    id: 2,
    channelId: CHANNEL_ID,
    role: 'assistant',
    authorId: 'companion:purrsephone',
    authorName: COMPANION_NAME,
    content: GENUINE_FEELING,
    timestamp: 2_000,
  },
  {
    id: 3,
    channelId: CHANNEL_ID,
    role: 'assistant',
    authorId: 'companion:purrsephone',
    authorName: COMPANION_NAME,
    content: STYLE_PREFERENCE,
    timestamp: 3_000,
  },
];

function fact(text: string, sourceMessageId: number, overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    text,
    type: 'emotional',
    importance: 0.8,
    emotionalValence: 0.5,
    confidence: 0.9,
    tags: [],
    attribution: { sourceMessageIds: [sourceMessageId] },
    ...overrides,
  };
}

describe('experiential self-memory exact grounding', () => {
  it('rejects a hallucinated feeling paraphrase that is absent from the cited assistant entry', () => {
    const result = normalizeExperientialSelfDirectedFact({
      fact: fact('I felt euphoric and fearless while painting the blue wash.', 2),
      entries,
      companionName: COMPANION_NAME,
    });

    expect(result).toEqual({
      accepted: false,
      reason: 'unsupported_experiential_text',
    });
  });

  it('rejects an otherwise exact feeling when it cites a scheduler/user entry', () => {
    const result = normalizeExperientialSelfDirectedFact({
      fact: fact(entries[0].content, 1),
      entries,
      companionName: COMPANION_NAME,
    });

    expect(result).toEqual({
      accepted: false,
      reason: 'invalid_companion_source_attribution',
    });
  });

  it('accepts a genuine first-person feeling copied from its cited assistant entry', () => {
    const result = normalizeExperientialSelfDirectedFact({
      fact: fact(GENUINE_FEELING, 2),
      entries,
      companionName: COMPANION_NAME,
    });

    expect(result).toMatchObject({
      accepted: true,
      fact: {
        text: GENUINE_FEELING,
        tags: expect.arrayContaining(['self_directed', 'self_experience']),
      },
      routing: {
        sourceMessageIds: [2],
        reason: 'self_directed_companion',
      },
    });
  });

  it('keeps an exact style dislike/preference durable and current for supersession semantics', () => {
    const result = normalizeExperientialSelfDirectedFact({
      fact: fact(STYLE_PREFERENCE, 3, {
        type: 'semantic',
        emotionalValence: -0.35,
        tags: ['style', 'dislike', 'preference'],
      }),
      entries,
      companionName: COMPANION_NAME,
    });

    expect(result).toMatchObject({
      accepted: true,
      fact: {
        text: STYLE_PREFERENCE,
        retentionClass: 'durable',
        tags: expect.arrayContaining([
          'self_style_exploration',
          'self_style_context',
          'preference',
          'preference:style',
          'current_state',
        ]),
      },
    });
  });
});
