import { describe, expect, it } from 'vitest';
import {
  buildExtractionNamingGuidance,
  detectDurableMemoryParticipantPlaceholders,
  normalizeDurableMemoryText,
  normalizeExtractedFactParticipantNames,
  resolveExtractionParticipantNames,
} from './naming.js';
import type { ExtractedFact } from '../types.js';

function factWithText(text: string): ExtractedFact {
  return {
    text,
    type: 'relational',
    importance: 0.9,
    emotionalValence: 0.6,
    confidence: 0.95,
    tags: ['trust'],
  };
}

describe('resolveExtractionParticipantNames', () => {
  it('prefers canonical contact name and configured companion names over generic labels', () => {
    const names = resolveExtractionParticipantNames({
      entries: [
        {
          id: 1,
          channelId: 'psfn-amica:test',
          role: 'user',
          content: 'hello',
          authorName: 'user',
          timestamp: 1,
        },
        {
          id: 2,
          channelId: 'psfn-amica:test',
          role: 'assistant',
          content: 'hi',
          authorName: 'assistant',
          timestamp: 2,
        },
      ],
      canonicalContactName: 'Alex',
      companionName: 'Lyra',
    });

    expect(names).toEqual({
      userName: 'Alex',
      companionName: 'Lyra',
    });
  });

  it('falls back to recent non-generic speaker names from the transcript', () => {
    const names = resolveExtractionParticipantNames({
      entries: [
        {
          id: 1,
          channelId: 'psfn-amica:test',
          role: 'user',
          content: 'hello',
          authorName: 'Alex',
          timestamp: 1,
        },
        {
          id: 2,
          channelId: 'psfn-amica:test',
          role: 'assistant',
          content: 'hi',
          authorName: 'Lyra',
          timestamp: 2,
        },
      ],
      canonicalContactName: 'user',
      companionName: 'assistant',
    });

    expect(names).toEqual({
      userName: 'Alex',
      companionName: 'Lyra',
    });
  });
});

describe('detectDurableMemoryParticipantPlaceholders', () => {
  it('detects generic labels and raw participant macros without matching hyphenated words', () => {
    expect(detectDurableMemoryParticipantPlaceholders(
      "The user trusts {{char}} and companion's patience.",
    )).toEqual({
      user: true,
      companion: true,
      userMacros: [],
      companionMacros: ['{{char}}'],
      hasAny: true,
    });

    expect(detectDurableMemoryParticipantPlaceholders(
      'The user-centric interface reduced friction.',
    )).toEqual({
      user: false,
      companion: false,
      userMacros: [],
      companionMacros: [],
      hasAny: false,
    });
  });

  it('does not treat bare assistant/companion/user nouns as placeholders', () => {
    expect(detectDurableMemoryParticipantPlaceholders(
      'The research assistant helped the power user with companion planting.',
    )).toEqual({
      user: false,
      companion: false,
      userMacros: [],
      companionMacros: [],
      hasAny: false,
    });
  });
});

describe('normalizeExtractedFactParticipantNames', () => {
  it('rewrites generic user and companion labels to real names', () => {
    const result = normalizeExtractedFactParticipantNames(factWithText(
      "The user trusts the companion's patience and the assistant's warmth.",
    ), {
      userName: 'Alex',
      companionName: 'Lyra',
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('expected fact to pass participant name hygiene');
    expect(result.fact.text).toBe("Alex trusts Lyra's patience and Lyra's warmth.");
  });

  it('rewrites raw character-card macros to resolved participant names', () => {
    const result = normalizeExtractedFactParticipantNames(factWithText(
      "{{user}} trusts {{char}}'s patience and {{assistant}}'s warmth.",
    ), {
      userName: 'Alex',
      companionName: 'Lyra',
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('expected macros to resolve');
    expect(result.fact.text).toBe("Alex trusts Lyra's patience and Lyra's warmth.");
  });

  it('collapses duplicate companion names from repeated macros', () => {
    const result = normalizeExtractedFactParticipantNames(factWithText(
      '{{char}} {{char}} keeps clear guardrails.',
    ), {
      companionName: 'Carlini',
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('expected duplicate macros to resolve');
    expect(result.fact.text).toBe('Carlini keeps clear guardrails.');
  });

  it('collapses adjacent duplicate participant names and possessive forms', () => {
    const plain = normalizeExtractedFactParticipantNames(factWithText(
      'Carlini Carlini needs livestream guardrails.',
    ), {
      companionName: 'Carlini',
    });
    const possessive = normalizeExtractedFactParticipantNames(factWithText(
      "Carlini Carlini's livestream needs guardrails.",
    ), {
      companionName: 'Carlini',
    });

    expect(plain.accepted).toBe(true);
    expect(possessive.accepted).toBe(true);
    if (!plain.accepted || !possessive.accepted) throw new Error('expected duplicate names to normalize');
    expect(plain.fact.text).toBe('Carlini needs livestream guardrails.');
    expect(possessive.fact.text).toBe("Carlini's livestream needs guardrails.");
  });

  it('rejects unresolved raw participant macros', () => {
    const result = normalizeExtractedFactParticipantNames(factWithText(
      '{{user}} wants {{char}} to remember the project.',
    ), {});

    expect(result).toEqual({
      accepted: false,
      fact: factWithText('{{user}} wants {{char}} to remember the project.'),
      reason: 'unresolved_participant_macro',
    });
  });

  it('leaves unrelated words intact', () => {
    const result = normalizeExtractedFactParticipantNames({
      ...factWithText('The user-centric interface reduced friction.'),
      type: 'semantic',
      importance: 0.6,
      emotionalValence: 0,
      confidence: 0.8,
      tags: ['ux'],
    }, {
      userName: 'Alex',
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('expected unrelated words to pass');
    expect(result.fact.text).toBe('The user-centric interface reduced friction.');
  });
});

describe('normalizeDurableMemoryText', () => {
  it('applies generic adjacent proper-name hygiene for profile summaries', () => {
    const result = normalizeDurableMemoryText(
      "Carlini Carlini's profile should not preserve duplicated names.",
      {},
    );

    expect(result).toEqual({
      accepted: true,
      text: "Carlini's profile should not preserve duplicated names.",
      changed: true,
    });
  });
});

describe('buildExtractionNamingGuidance', () => {
  it('emits explicit name fidelity instructions when names are available', () => {
    const guidance = buildExtractionNamingGuidance({
      userName: 'Alex',
      companionName: 'Lyra',
    });

    expect(guidance).toContain('Human participant name: Alex');
    expect(guidance).toContain('Companion participant name: Lyra');
    expect(guidance).toContain('Do not write generic placeholders');
    expect(guidance).toContain('Never write raw character-card macros');
  });
});
