import { describe, expect, it, vi } from 'vitest';
import type { ExtractedFact } from '../types.js';
import { MemoryWritePolicyError } from '../writer.js';
import { ExtractionIntegrityError } from './integrity-error.js';
import type { RoutedAcceptedFactCandidate } from './fact-acceptance.js';
import {
  buildExtractionFactRoutingTelemetry,
  executeAcceptedFactWrites,
  type FactWriteExecutionInput,
} from './write-execution.js';

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

function candidate(
  index: number,
  overrides: Partial<RoutedAcceptedFactCandidate> = {},
): RoutedAcceptedFactCandidate {
  return {
    fact: fact(`fact ${index}`),
    novelty: 1,
    valueScore: 0.5,
    index,
    routing: {
      status: 'route',
      contactId: 'contact-alex',
      sourceSpeakerName: 'Alex',
      reason: 'single_speaker_transcript',
    },
    ...overrides,
  };
}

function buildInput(
  overrides: Partial<FactWriteExecutionInput> = {},
): FactWriteExecutionInput {
  return {
    selectedCandidates: [],
    sourceRef: 'session:api:test',
    canonicalContactId: 'contact-alex',
    channelId: 'api:test',
    triggerReason: 'manual',
    turnId: undefined,
    telemetryEnabled: false,
    isAcceptingExtractions: () => true,
    processFact: vi.fn().mockResolvedValue({
      action: 'created',
      memory: { id: 'mem-1' },
    }),
    ...overrides,
  };
}

const emptyRejections = {
  low_importance: 0,
  low_confidence: 0,
  low_novelty: 0,
  low_signal: 0,
  cogsec_risk: 0,
  ambiguous_speaker: 0,
  write_cap: 0,
};

describe('executeAcceptedFactWrites', () => {
  it('writes a created fact and records the full accepted-write shape', async () => {
    const processFact = vi.fn().mockResolvedValue({ action: 'created', memory: { id: 'mem-1' } });
    const one = candidate(0);
    const result = await executeAcceptedFactWrites(buildInput({
      selectedCandidates: [one],
      processFact,
    }));
    expect(processFact).toHaveBeenCalledWith(
      one.fact,
      'session:api:test',
      'contact-alex',
      buildExtractionFactRoutingTelemetry(one.routing, 'contact-alex'),
    );
    expect(result.acceptedCount).toBe(1);
    expect(result.writeCount).toBe(1);
    expect(result.deduplicatedCount).toBe(0);
    expect(result.supersededCount).toBe(0);
    expect(result.routedFactCount).toBe(0);
    expect([...result.durableMemoryIds]).toEqual(['mem-1']);
    expect(result.acceptedWrites).toEqual([{
      memoryId: 'mem-1',
      importance: 0.8,
      confidence: 0.9,
      contactId: 'contact-alex',
      triggerContactId: 'contact-alex',
      sourceSpeakerName: 'Alex',
    }]);
    expect(result.acceptedFactsForConcernCandidates).toEqual([one.fact]);
    expect([...result.acceptedFactsByContact.keys()]).toEqual(['contact-alex']);
    expect([...result.routedContactIds]).toEqual(['contact-alex']);
    expect([...result.sourceSpeakerNames]).toEqual(['Alex']);
    expect(result.writePolicyRejections).toEqual(emptyRejections);
  });

  it('tracks superseded writes and folds superseded memory ids into the durable set', async () => {
    const result = await executeAcceptedFactWrites(buildInput({
      selectedCandidates: [candidate(0)],
      processFact: vi.fn().mockResolvedValue({
        action: 'superseded',
        memory: { id: 'mem-2' },
        supersededMemoryIds: ['mem-old'],
      }),
    }));
    expect(result.writeCount).toBe(1);
    expect(result.supersededCount).toBe(1);
    expect([...result.durableMemoryIds].sort()).toEqual(['mem-2', 'mem-old']);
    expect(result.acceptedWrites).toHaveLength(1);
  });

  it('counts deduplicated results as accepted without recording a write', async () => {
    const result = await executeAcceptedFactWrites(buildInput({
      selectedCandidates: [candidate(0)],
      processFact: vi.fn().mockResolvedValue({
        action: 'deduplicated',
        memory: { id: 'mem-3' },
      }),
    }));
    expect(result.acceptedCount).toBe(1);
    expect(result.writeCount).toBe(0);
    expect(result.deduplicatedCount).toBe(1);
    expect(result.acceptedWrites).toEqual([]);
    // Deduplicated facts still feed concern candidates and emotional state.
    expect(result.acceptedFactsForConcernCandidates).toHaveLength(1);
    expect([...result.durableMemoryIds]).toEqual(['mem-3']);
  });

  it('counts a fact routed away from the trigger contact', async () => {
    const result = await executeAcceptedFactWrites(buildInput({
      selectedCandidates: [candidate(0, {
        routing: {
          status: 'route',
          contactId: 'contact-sam',
          sourceSpeakerName: 'Sam',
          reason: 'clear_source_speaker',
        },
      })],
    }));
    expect(result.routedFactCount).toBe(1);
    expect([...result.routedContactIds]).toEqual(['contact-sam']);
  });

  it('stops writing when the extractor stops accepting mid-run', async () => {
    const processFact = vi.fn().mockResolvedValue({ action: 'created', memory: { id: 'mem-1' } });
    let calls = 0;
    const result = await executeAcceptedFactWrites(buildInput({
      selectedCandidates: [candidate(0), candidate(1)],
      isAcceptingExtractions: () => {
        calls += 1;
        return calls === 1;
      },
      processFact,
    }));
    expect(processFact).toHaveBeenCalledTimes(1);
    expect(result.acceptedCount).toBe(1);
  });

  it('maps write-policy rejections to breakdown reasons and continues the loop', async () => {
    const policyError = (reason: 'novelty_below_threshold' | 'salience_below_threshold') =>
      new MemoryWritePolicyError({
        reason,
        sensitivity: 'personal',
        salience: 0.1,
        novelty: 0.1,
        minSalience: 0.5,
        minNovelty: 0.5,
      });
    const processFact = vi.fn()
      .mockRejectedValueOnce(policyError('novelty_below_threshold'))
      .mockRejectedValueOnce(policyError('salience_below_threshold'))
      .mockResolvedValueOnce({ action: 'created', memory: { id: 'mem-1' } });
    const result = await executeAcceptedFactWrites(buildInput({
      selectedCandidates: [candidate(0), candidate(1), candidate(2)],
      processFact,
    }));
    expect(result.writePolicyRejections).toEqual({
      ...emptyRejections,
      low_novelty: 1,
      low_importance: 1,
    });
    expect(result.acceptedCount).toBe(1);
    expect(result.writeCount).toBe(1);
  });

  it('wraps unexpected write failures in a fact_processing integrity error', async () => {
    const cause = new Error('store offline');
    const input = buildInput({
      selectedCandidates: [candidate(3, { index: 3 })],
      processFact: vi.fn().mockRejectedValue(cause),
    });
    const thrown = await executeAcceptedFactWrites(input).catch(error => error);
    expect(thrown).toBeInstanceOf(ExtractionIntegrityError);
    expect(thrown.context).toEqual({
      stage: 'fact_processing',
      channelId: 'api:test',
      triggerReason: 'manual',
      factIndex: 3,
      factType: 'semantic',
      sourceRef: 'session:api:test',
    });
    expect(thrown.cause).toBe(cause);
  });
});

describe('buildExtractionFactRoutingTelemetry', () => {
  it('carries every present routing field and omits the absent ones', () => {
    expect(buildExtractionFactRoutingTelemetry(
      {
        status: 'route',
        contactId: 'contact-sam',
        sourceContactId: 'contact-sam',
        sourceAuthorId: 'sam',
        sourceSpeakerName: 'Sam',
        subjectName: 'Sam',
        addressMode: 'direct_to_companion',
        sourceMessageIds: [4, 5],
        sourceSpanStartMessageId: 4,
        sourceSpanEndMessageId: 5,
        reason: 'clear_source_speaker',
      },
      'contact-alex',
    )).toEqual({
      triggerContactId: 'contact-alex',
      routedContactId: 'contact-sam',
      sourceContactId: 'contact-sam',
      sourceAuthorId: 'sam',
      sourceSpeakerName: 'Sam',
      subjectName: 'Sam',
      addressMode: 'direct_to_companion',
      sourceMessageIds: [4, 5],
      sourceSpanStartMessageId: 4,
      sourceSpanEndMessageId: 5,
      routingReason: 'clear_source_speaker',
    });
  });

  it('omits the trigger contact when the run has none', () => {
    const telemetry = buildExtractionFactRoutingTelemetry(
      { status: 'route', reason: 'single_speaker_transcript' },
      undefined,
    );
    expect(telemetry).toEqual({ routingReason: 'single_speaker_transcript' });
  });
});
