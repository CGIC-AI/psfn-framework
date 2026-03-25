import { describe, expect, it } from 'vitest';
import {
  buildExtractionNamingGuidance,
  normalizeExtractedFactParticipantNames,
  resolveExtractionParticipantNames,
} from './naming.js';

describe('resolveExtractionParticipantNames', () => {
  it('prefers canonical contact and configured companion names over generic labels', () => {
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
      canonicalContactDisplayName: 'Operator',
      companionName: 'PSFN',
    });

    expect(names).toEqual({
      userName: 'Operator',
      companionName: 'PSFN',
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
          authorName: 'Operator',
          timestamp: 1,
        },
        {
          id: 2,
          channelId: 'psfn-amica:test',
          role: 'assistant',
          content: 'hi',
          authorName: 'PSFN',
          timestamp: 2,
        },
      ],
      canonicalContactDisplayName: 'user',
      companionName: 'assistant',
    });

    expect(names).toEqual({
      userName: 'Operator',
      companionName: 'PSFN',
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
      userName: 'Operator',
      companionName: 'PSFN',
    });

    expect(fact.text).toBe("Operator trusts PSFN's patience and PSFN's warmth.");
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
      userName: 'Operator',
    });

    expect(fact.text).toBe('The user-centric interface reduced friction.');
  });
});

describe('buildExtractionNamingGuidance', () => {
  it('emits explicit name fidelity instructions when names are available', () => {
    const guidance = buildExtractionNamingGuidance({
      userName: 'Operator',
      companionName: 'PSFN',
    });

    expect(guidance).toContain('Human participant name: Operator');
    expect(guidance).toContain('Companion participant name: PSFN');
    expect(guidance).toContain('Do not write generic placeholders');
  });
});
