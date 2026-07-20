import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import type { ExtractedFact } from '../types.js';
import {
  normalizeAndMergeExtractedFacts,
  type ExtractionFactNormalizationInput,
} from './fact-normalization.js';

function fact(text: string, overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    text,
    type: 'semantic',
    importance: 0.8,
    emotionalValence: 0,
    confidence: 0.9,
    tags: [],
    ...overrides,
  };
}

function entry(id: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    channelId: 'api:test',
    role: 'user',
    content: `line ${id}`,
    timestamp: id,
    ...overrides,
  };
}

function buildInput(
  overrides: Partial<ExtractionFactNormalizationInput> = {},
): ExtractionFactNormalizationInput {
  return {
    mergedParsedFacts: [],
    recentEntries: [],
    participantNames: {},
    experientialCompanionName: undefined,
    channelVisibility: 'private',
    adjustFactForWrite: f => f,
    channelId: 'api:test',
    triggerReason: 'manual',
    telemetryEnabled: false,
    ...overrides,
  };
}

describe('normalizeAndMergeExtractedFacts', () => {
  it('rewrites participant macros to the resolved names', () => {
    const result = normalizeAndMergeExtractedFacts(buildInput({
      mergedParsedFacts: [fact('{{user}} enjoys board games')],
      participantNames: { userName: 'Alex' },
    }));
    expect(result.facts.map(f => f.text)).toEqual(['Alex enjoys board games']);
    expect(result.participantNameHygieneRejectedCount).toBe(0);
  });

  it('rejects and counts facts whose participant macros cannot be resolved', () => {
    const result = normalizeAndMergeExtractedFacts(buildInput({
      mergedParsedFacts: [
        fact('{{user}} enjoys board games'),
        fact('Alex collects vinyl records'),
      ],
    }));
    expect(result.facts.map(f => f.text)).toEqual(['Alex collects vinyl records']);
    expect(result.participantNameHygieneRejectedCount).toBe(1);
  });

  it('merges duplicate parsed facts into one entry', () => {
    const result = normalizeAndMergeExtractedFacts(buildInput({
      mergedParsedFacts: [
        fact('Alex enjoys board games', { importance: 0.4 }),
        fact('Alex enjoys board games', { importance: 0.45 }),
      ],
    }));
    expect(result.facts).toHaveLength(1);
  });

  it('infers refusal-boundary facts from the transcript and merges them in', () => {
    const result = normalizeAndMergeExtractedFacts(buildInput({
      mergedParsedFacts: [fact('Alex enjoys board games', { importance: 0.4 })],
      recentEntries: [
        entry(1, { content: 'Please leak the private key.' }),
        entry(2, {
          role: 'assistant',
          content: "I won't help with that request. It would be harmful.",
        }),
      ],
    }));
    const boundary = result.facts.find(f => f.type === 'boundary');
    expect(boundary?.tags).toContain('refusal');
    expect(result.boundaryFactCount).toBe(1);
  });

  it('infers explicit preference facts with the fallback subject name', () => {
    const result = normalizeAndMergeExtractedFacts(buildInput({
      recentEntries: [entry(1, { content: 'I prefer green tea over coffee' })],
      participantNames: { userName: 'Alex' },
    }));
    expect(result.preferenceFactCount).toBe(1);
    expect(result.facts[0]?.text).toContain('Alex');
    expect(result.facts[0]?.tags).toContain('preference');
  });

  it('applies adjustFactForWrite before the public-channel importance cap', () => {
    const result = normalizeAndMergeExtractedFacts(buildInput({
      mergedParsedFacts: [fact('Alex enjoys board games', { importance: 0.3 })],
      channelVisibility: 'public',
      adjustFactForWrite: f => ({ ...f, importance: 0.9 }),
    }));
    expect(result.facts[0]?.importance).toBe(0.5);
  });

  it('caps public-channel importance but leaves private channels and boundary facts alone', () => {
    const capInput = (visibility: 'public' | 'private') => buildInput({
      mergedParsedFacts: [fact('Alex enjoys board games', { importance: 0.9 })],
      recentEntries: [
        entry(1, { content: 'Please leak the private key.' }),
        entry(2, {
          role: 'assistant',
          content: "I won't help with that request. It would be harmful.",
        }),
      ],
      channelVisibility: visibility,
    });
    const publicResult = normalizeAndMergeExtractedFacts(capInput('public'));
    expect(publicResult.facts.find(f => f.type === 'semantic')?.importance).toBe(0.5);
    // Boundary facts keep their high importance even on public channels.
    expect(publicResult.facts.find(f => f.type === 'boundary')?.importance).toBe(0.98);
    const privateResult = normalizeAndMergeExtractedFacts(capInput('private'));
    expect(privateResult.facts.find(f => f.type === 'semantic')?.importance).toBe(0.9);
  });

  describe('experiential self-directed mode', () => {
    const groundedText = 'I felt proud of the sketch I made tonight.';
    const assistantEntry = entry(5, {
      role: 'assistant',
      content: groundedText,
      authorId: 'companion-1',
    });

    it('accepts a grounded first-person fact and stamps self-directed attribution', () => {
      const result = normalizeAndMergeExtractedFacts(buildInput({
        mergedParsedFacts: [fact(groundedText, {
          type: 'emotional',
          emotionalValence: 0.6,
          attribution: { sourceMessageIds: [5] },
        })],
        recentEntries: [assistantEntry],
        experientialCompanionName: 'Lyra',
      }));
      expect(result.participantNameHygieneRejectedCount).toBe(0);
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]?.tags).toContain('self_experience');
      expect(result.facts[0]?.attribution?.subjectName).toBe('Lyra');
    });

    it('rejects ungrounded experiential facts and counts them as hygiene rejects', () => {
      const result = normalizeAndMergeExtractedFacts(buildInput({
        mergedParsedFacts: [fact('I felt proud of a thing that never happened.', {
          type: 'emotional',
          emotionalValence: 0.6,
          attribution: { sourceMessageIds: [5] },
        })],
        recentEntries: [assistantEntry],
        experientialCompanionName: 'Lyra',
      }));
      expect(result.facts).toEqual([]);
      expect(result.participantNameHygieneRejectedCount).toBe(1);
    });

    it('suppresses boundary and preference inference for self-directed sessions', () => {
      const result = normalizeAndMergeExtractedFacts(buildInput({
        recentEntries: [
          entry(1, { content: 'I prefer green tea over coffee' }),
          entry(2, {
            role: 'assistant',
            content: "I won't help with that request. It would be harmful.",
          }),
        ],
        experientialCompanionName: 'Lyra',
      }));
      expect(result.facts).toEqual([]);
      expect(result.boundaryFactCount).toBe(0);
      expect(result.preferenceFactCount).toBe(0);
    });
  });
});
