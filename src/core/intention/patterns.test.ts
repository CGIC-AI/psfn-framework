import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BehavioralPatternTracker,
  createBehavioralPatternMemoryPromotionHook,
  type BehavioralPatternPromotionCandidate,
} from './patterns.js';

describe('BehavioralPatternTracker', () => {
  let db: Database.Database;
  let nowMs: number;
  let idCounter: number;
  let tracker: BehavioralPatternTracker;

  beforeEach(() => {
    db = new Database(':memory:');
    nowMs = Date.parse('2026-03-06T12:00:00.000Z');
    idCounter = 0;
    tracker = new BehavioralPatternTracker(db, {
      now: () => new Date(nowMs),
      idFactory: () => `pattern-${++idCounter}`,
      minimumSamplesForPromotion: 2,
      minimumAverageOutcomeForPromotion: 0.2,
    });
  });

  it('keeps recorded samples isolated per contact', () => {
    tracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-1',
      responseContent: 'I hear you and that sounds difficult.',
      strategy: 'empathy',
    });
    tracker.recordResponseStrategy({
      contactId: 'contact-b',
      sourceMessageId: 'msg-b-1',
      responseContent: 'Let us break this into implementation steps.',
      strategy: 'technical',
    });

    const contactASamples = tracker.listSamples({
      contactId: 'contact-a',
      includePending: true,
      limit: 10,
    });
    expect(contactASamples).toHaveLength(1);
    expect(contactASamples[0]?.contactId).toBe('contact-a');

    const contactBSamples = tracker.listSamples({
      contactId: 'contact-b',
      includePending: true,
      limit: 10,
    });
    expect(contactBSamples).toHaveLength(1);
    expect(contactBSamples[0]?.contactId).toBe('contact-b');
  });

  it('records outcomes and surfaces behavioral notes only for resolved data', async () => {
    tracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-1',
      responseContent: 'That makes sense and your reaction is valid.',
      strategy: 'validation',
    });

    const pendingNotes = tracker.getBehavioralNotes('contact-a');
    expect(pendingNotes).toBe('');

    const resolved = await tracker.tryRecordOutcomeForLatestPending({
      contactId: 'contact-a',
      outcomeScore: 0.45,
      outcomeSourceMessageId: 'msg-a-2',
    });
    expect(resolved).toBeTruthy();
    expect(resolved?.outcomeScore).toBeCloseTo(0.45, 6);
    expect(resolved?.outcomeSourceMessageId).toBe('msg-a-2');

    const notes = tracker.getBehavioralNotes('contact-a');
    expect(notes).toContain('<behavioral_notes>');
    expect(notes).toContain('validation');
    expect(notes).toContain('avg +0.45');
    expect(notes).toContain('</behavioral_notes>');
    expect(tracker.getBehavioralNotes('contact-b')).toBe('');
  });

  it('fails closed on ambiguous sourceMessage outcome updates', async () => {
    tracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-1',
      responseContent: 'I hear you.',
      strategy: 'empathy',
    });
    tracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-1',
      responseContent: 'Let us focus on next steps.',
      strategy: 'redirect',
    });

    await expect(tracker.recordOutcomeForSample({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-1',
      outcomeScore: 0.2,
    })).rejects.toThrow('ambiguous');
  });

  it('invokes promotion hook once when strategy crosses thresholds', async () => {
    const promotionHook = vi.fn().mockResolvedValue({ memoryId: 'mem-pattern-1' });
    tracker.setPromotionHook(promotionHook);

    tracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-1',
      responseContent: 'That is valid and understandable.',
      strategy: 'validation',
    });
    await tracker.recordOutcomeForSample({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-1',
      strategy: 'validation',
      outcomeScore: 0.3,
    });
    expect(promotionHook).not.toHaveBeenCalled();

    tracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-2',
      responseContent: 'Your reaction makes sense.',
      strategy: 'validation',
    });
    await tracker.recordOutcomeForSample({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-2',
      strategy: 'validation',
      outcomeScore: 0.6,
    });

    expect(promotionHook).toHaveBeenCalledTimes(1);
    const candidate = promotionHook.mock.calls[0]?.[0] as BehavioralPatternPromotionCandidate;
    expect(candidate).toMatchObject({
      contactId: 'contact-a',
      strategy: 'validation',
      sampleCount: 2,
    });
    expect(candidate.averageOutcome).toBeCloseTo(0.45, 6);
    expect(candidate.proceduralMemoryText).toContain('validation responses trend beneficial');

    tracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-3',
      responseContent: 'I understand why that felt difficult.',
      strategy: 'validation',
    });
    await tracker.recordOutcomeForSample({
      contactId: 'contact-a',
      sourceMessageId: 'msg-a-3',
      strategy: 'validation',
      outcomeScore: 0.5,
    });
    expect(promotionHook).toHaveBeenCalledTimes(1);

    const promotedRows = tracker.listSamples({
      contactId: 'contact-a',
      includePending: true,
      limit: 10,
    });
    expect(promotedRows.every(row => row.promotedMemoryId === 'mem-pattern-1')).toBe(true);
    expect(promotedRows.every(row => row.promotedAt !== undefined)).toBe(true);
  });
});

describe('createBehavioralPatternMemoryPromotionHook', () => {
  it('writes procedural memories with contact-local metadata', async () => {
    const write = vi.fn().mockResolvedValue({
      action: 'created',
      memory: { id: 'mem-123' },
    });
    const hook = createBehavioralPatternMemoryPromotionHook({ write } as any);
    const result = await hook({
      contactId: 'contact-z',
      strategy: 'empathy',
      sampleCount: 4,
      averageOutcome: 0.37,
      positiveRate: 0.75,
      proceduralMemoryText: 'For this contact, empathy responses trend beneficial.',
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      type: 'procedural',
      contactId: 'contact-z',
      sourceRef: 'intention:behavioral_pattern_tracker',
    }));
    expect(result).toEqual({ memoryId: 'mem-123' });
  });
});
