import { describe, expect, it } from 'vitest';
import {
  buildExtractionNamingGuidance,
  normalizeExtractedFactParticipantNames,
  resolveExtractionParticipantNames,
} from './naming.js';

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

describe('normalizeExtractedFactParticipantNames', () => {
  it('rewrites generic user and companion labels to real names', () => {
    const fact = normalizeExtractedFactParticipantNames({
      text: "The user trusts the companion's patience and the assistant's warmth.",
      type: 'relational',
      importance: 0.9,
      emotionalValence: 0.6,
      confidence: 0.95,
      tags: ['trust'],
    }, {
      userName: 'Alex',
      companionName: 'Lyra',
    });

    expect(fact.text).toBe("Alex trusts Lyra's patience and Lyra's warmth.");
  });

  it('leaves unrelated words intact', () => {
    const fact = normalizeExtractedFactParticipantNames({
      text: 'The user-centric interface reduced friction.',
      type: 'semantic',
      importance: 0.6,
      emotionalValence: 0,
      confidence: 0.8,
      tags: ['ux'],
    }, {
      userName: 'Alex',
    });

    expect(fact.text).toBe('The user-centric interface reduced friction.');
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
  });
});
