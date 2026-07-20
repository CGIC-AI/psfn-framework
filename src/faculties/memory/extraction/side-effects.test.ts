import { describe, expect, it, vi } from 'vitest';
import type { ExtractedFact } from '../types.js';
import type { AcceptedFactWrite } from './types.js';
import {
  groupAcceptedWritesByContact,
  resolveProfileRefreshContactIds,
  runExtractionSideEffects,
  type ExtractionSideEffectsInput,
} from './side-effects.js';

function fact(text: string): ExtractedFact {
  return {
    text,
    type: 'semantic',
    importance: 0.8,
    emotionalValence: 0,
    confidence: 0.9,
    tags: [],
  };
}

function write(overrides: Partial<AcceptedFactWrite> = {}): AcceptedFactWrite {
  return {
    memoryId: 'mem-1',
    importance: 0.8,
    confidence: 0.9,
    ...overrides,
  };
}

function buildInput(
  overrides: Partial<ExtractionSideEffectsInput> = {},
): ExtractionSideEffectsInput {
  return {
    channelId: 'api:test',
    triggerReason: 'manual',
    canonicalContactId: 'contact-alex',
    turnId: undefined,
    sourceRef: 'session:api:test',
    recentEntries: [],
    existingMemories: [],
    acceptedFactsForConcernCandidates: [],
    acceptedWrites: [],
    acceptedFactsByContact: new Map(),
    emitConcernCandidates: undefined,
    maybePersistEmotionalState: vi.fn().mockResolvedValue(undefined),
    maybeRefreshContactProfile: vi.fn().mockResolvedValue(undefined),
    assertEffectAllowed: undefined,
    ...overrides,
  };
}

describe('runExtractionSideEffects', () => {
  it('emits concern candidates with the full extraction context and collects the ids', async () => {
    const emitConcernCandidates = vi.fn().mockResolvedValue(['concern-1', 'concern-2']);
    const memory = {
      id: 'mem-9',
      type: 'semantic' as const,
      text: 'existing memory',
      importance: 0.7,
      confidence: 0.8,
      salience: 0.6,
      sourceRef: 'session:old',
    };
    const acceptedFacts = [fact('Alex enjoys board games')];
    const acceptedWrites = [write({ contactId: 'contact-alex' })];
    const result = await runExtractionSideEffects(buildInput({
      existingMemories: [memory],
      acceptedFactsForConcernCandidates: acceptedFacts,
      acceptedWrites,
      emitConcernCandidates,
    }));
    expect(emitConcernCandidates).toHaveBeenCalledWith({
      channelId: 'api:test',
      triggerReason: 'manual',
      canonicalContactId: 'contact-alex',
      sourceRef: 'session:api:test',
      recentEntries: [],
      acceptedFacts,
      acceptedWrites,
      relatedMemories: [memory],
    });
    expect(result.concernIds).toEqual(['concern-1', 'concern-2']);
  });

  it('tolerates a concern sink that returns undefined', async () => {
    const result = await runExtractionSideEffects(buildInput({
      emitConcernCandidates: vi.fn().mockResolvedValue(undefined),
    }));
    expect(result.concernIds).toEqual([]);
  });

  it('persists emotional state once per routed contact group', async () => {
    const maybePersistEmotionalState = vi.fn()
      .mockResolvedValueOnce('contact-alex')
      .mockResolvedValueOnce(undefined);
    const alexFacts = [fact('Alex enjoys board games')];
    const samFacts = [fact('Sam collects synthesizers')];
    const result = await runExtractionSideEffects(buildInput({
      acceptedFactsByContact: new Map([
        ['contact-alex', alexFacts],
        ['contact-sam', samFacts],
      ]),
      maybePersistEmotionalState,
    }));
    expect(maybePersistEmotionalState).toHaveBeenNthCalledWith(1, 'contact-alex', alexFacts, []);
    expect(maybePersistEmotionalState).toHaveBeenNthCalledWith(2, 'contact-sam', samFacts, []);
    // Only mutated contacts are reported back.
    expect(result.contactIds).toEqual(['contact-alex']);
  });

  it('falls back to one empty emotional-state pass for the trigger contact when nothing was accepted', async () => {
    const maybePersistEmotionalState = vi.fn().mockResolvedValue(undefined);
    await runExtractionSideEffects(buildInput({ maybePersistEmotionalState }));
    expect(maybePersistEmotionalState).toHaveBeenCalledTimes(1);
    expect(maybePersistEmotionalState).toHaveBeenCalledWith('contact-alex', [], []);
  });

  it('refreshes the trigger-contact profile with an empty write set when nothing was written', async () => {
    const maybeRefreshContactProfile = vi.fn().mockResolvedValue(undefined);
    await runExtractionSideEffects(buildInput({ maybeRefreshContactProfile }));
    expect(maybeRefreshContactProfile).toHaveBeenCalledTimes(1);
    expect(maybeRefreshContactProfile).toHaveBeenCalledWith('api:test', 'manual', 'contact-alex', []);
  });

  it('refreshes one profile per routed contact and subject contact', async () => {
    const maybeRefreshContactProfile = vi.fn().mockResolvedValue(undefined);
    const routedWrite = write({ contactId: 'contact-sam', subjectContactId: 'contact-kim' });
    await runExtractionSideEffects(buildInput({
      acceptedWrites: [routedWrite],
      maybeRefreshContactProfile,
    }));
    expect(maybeRefreshContactProfile).toHaveBeenCalledTimes(2);
    expect(maybeRefreshContactProfile).toHaveBeenCalledWith(
      'api:test', 'manual', 'contact-sam', [routedWrite],
    );
    expect(maybeRefreshContactProfile).toHaveBeenCalledWith(
      'api:test', 'manual', 'contact-kim', [{ ...routedWrite, contactId: 'contact-kim' }],
    );
  });

  it('holds the effect fence before the concern sink and before every durable child', async () => {
    const order: string[] = [];
    const assertEffectAllowed = vi.fn(async () => { order.push('fence'); });
    await runExtractionSideEffects(buildInput({
      acceptedWrites: [write({ contactId: 'contact-alex' })],
      acceptedFactsByContact: new Map([['contact-alex', [fact('Alex enjoys board games')]]]),
      emitConcernCandidates: vi.fn(async () => { order.push('concerns'); return []; }),
      maybePersistEmotionalState: vi.fn(async () => { order.push('emotional'); return undefined; }),
      maybeRefreshContactProfile: vi.fn(async () => { order.push('profile'); }),
      assertEffectAllowed,
    }));
    expect(order).toEqual(['fence', 'concerns', 'fence', 'emotional', 'fence', 'profile']);
  });

  it('propagates a denied effect fence instead of running the remaining children', async () => {
    const maybeRefreshContactProfile = vi.fn();
    await expect(runExtractionSideEffects(buildInput({
      assertEffectAllowed: vi.fn().mockRejectedValue(new Error('fence lost')),
      maybeRefreshContactProfile,
    }))).rejects.toThrow('fence lost');
    expect(maybeRefreshContactProfile).not.toHaveBeenCalled();
  });
});

describe('groupAcceptedWritesByContact', () => {
  it('returns a single fallback group when there are no writes', () => {
    const groups = groupAcceptedWritesByContact([], 'contact-alex');
    expect([...groups.entries()]).toEqual([['contact-alex', []]]);
  });

  it('clones a write into its subject-contact group with the contact id rewritten', () => {
    const routedWrite = write({ contactId: 'contact-sam', subjectContactId: 'contact-kim' });
    const groups = groupAcceptedWritesByContact([routedWrite], 'contact-alex');
    expect(groups.get('contact-sam')).toEqual([routedWrite]);
    expect(groups.get('contact-kim')).toEqual([{ ...routedWrite, contactId: 'contact-kim' }]);
    expect(groups.has('contact-alex')).toBe(false);
  });
});

describe('resolveProfileRefreshContactIds', () => {
  it('uses the fallback contact only for unscoped writes without contact attribution', () => {
    expect(resolveProfileRefreshContactIds(write(), 'contact-alex')).toEqual(['contact-alex']);
    expect(resolveProfileRefreshContactIds(
      write({ scopeRef: { kind: 'system', id: 'companion:self' } }),
      'contact-alex',
    )).toEqual([]);
    expect(resolveProfileRefreshContactIds(write(), undefined)).toEqual([]);
  });

  it('collects the routed contact and subject contact without duplicates', () => {
    expect(resolveProfileRefreshContactIds(
      write({ contactId: 'contact-sam', subjectContactId: 'contact-sam' }),
      'contact-alex',
    )).toEqual(['contact-sam']);
  });
});
