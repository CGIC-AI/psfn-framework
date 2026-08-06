import { describe, expect, it, vi } from 'vitest';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import type { SessionEntry } from '../../session/types.js';
import {
  collectDailyReviewEvidence,
  type DailyReviewEvidenceScope,
} from './daily-review-evidence.js';

const NOW_MS = Date.parse('2026-08-04T10:00:00.000Z');
const WINDOW_MS = 24 * 60 * 60 * 1000;
const SCOPE: DailyReviewEvidenceScope = {
  kind: 'contact',
  sessionId: 'discord:primary',
  canonicalContactId: 'contact-1',
};

function sessionEntry(input: Partial<SessionEntry> & Pick<SessionEntry, 'id' | 'content'>): SessionEntry {
  return {
    channelId: 'discord:primary',
    role: 'user',
    timestamp: NOW_MS - 60_000,
    ...input,
  };
}

function episode(input: Partial<Episode> & Pick<Episode, 'id' | 'title' | 'landmark'>): Episode {
  return {
    schemaVersion: 2,
    startedAt: '2026-08-04T08:00:00.000Z',
    endedAt: '2026-08-04T09:00:00.000Z',
    participantContactIds: ['contact-1'],
    salience: { score: 0.8 },
    affect: { labels: [] },
    themes: [],
    spanRefs: [{ spanId: 'span-1', sessionId: 'discord:primary' }],
    artifactRefs: [],
    provenanceRefs: [],
    createdAt: '2026-08-04T09:00:00.000Z',
    updatedAt: '2026-08-04T09:00:00.000Z',
    ...input,
  };
}

function memory(input: Partial<PurrMemory> & Pick<PurrMemory, 'id' | 'text' | 'type'>): PurrMemory {
  return {
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.7,
    sourceRef: 'source:turn',
    extractedAt: NOW_MS - 30_000,
    lastAccessed: NOW_MS - 30_000,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    contactId: 'contact-1',
    provenance: { channelId: 'discord:primary' },
    ...input,
  };
}

describe('collectDailyReviewEvidence', () => {
  it('rejects an invalid review window instead of constructing an unbounded query', async () => {
    await expect(collectDailyReviewEvidence({
      nowMs: NOW_MS,
      windowMs: 0,
      scope: SCOPE,
    })).rejects.toThrow('positive review window');
  });

  it('builds a bounded, chronological day summary across conversation, episodes, and memory deltas', async () => {
    const sessionEntries = [
      sessionEntry({ id: 1, content: 'Too old', timestamp: NOW_MS - WINDOW_MS - 1 }),
      sessionEntry({ id: 2, content: 'Morning recovery-plan check-in', timestamp: NOW_MS - 20 * 60 * 60 * 1000 }),
      sessionEntry({ id: 3, role: 'assistant', authorName: 'Purrsephone', content: 'Afternoon handoff follow-up', timestamp: NOW_MS - 12 * 60 * 60 * 1000 }),
      sessionEntry({ id: 4, content: 'Evening garden planning', timestamp: NOW_MS - 4 * 60 * 60 * 1000 }),
      sessionEntry({ id: 5, content: 'Late-night reassurance', timestamp: NOW_MS - 60 * 60 * 1000 }),
    ];
    const searchByTime = vi.fn(async () => [
      episode({ id: 'episode-1', title: 'Recovery handoff', landmark: 'We made the next step explicit.' }),
      episode({ id: 'episode-2', title: 'Garden planning', landmark: 'We chose the first layout.' }),
      episode({ id: 'episode-3', title: 'Cut episode', landmark: 'This exceeds the rendered bound.' }),
    ]);
    const listActiveMemories = vi.fn(async () => [
      memory({ id: 'memory-1', type: 'episodic', text: 'The recovery plan still needs a follow-up.' }),
      memory({ id: 'memory-2', type: 'semantic', text: 'The garden layout should start with the shaded bed.' }),
      memory({ id: 'memory-foreign', type: 'semantic', text: 'Foreign contact detail', contactId: 'contact-2', provenance: { channelId: 'discord:foreign' } }),
      memory({ id: 'memory-old', type: 'semantic', text: 'Old detail', extractedAt: NOW_MS - WINDOW_MS - 1 }),
    ]);

    const result = await collectDailyReviewEvidence({
      nowMs: NOW_MS,
      windowMs: WINDOW_MS,
      scope: SCOPE,
      sessionManager: { getRecentMessages: () => sessionEntries },
      episodicStore: { searchByTime },
      memoryStore: { listActiveMemories },
    });

    expect(result.degraded).toBe(false);
    expect(result.promptSection).toContain('[Deterministic Day Evidence]');
    expect(result.promptSection).toContain('4 recorded conversation messages');
    expect(result.promptSection).toContain('Morning recovery-plan check-in');
    expect(result.promptSection).toContain('Afternoon handoff follow-up');
    expect(result.promptSection).not.toContain('Evening garden planning');
    expect(result.promptSection).toContain('Late-night reassurance');
    expect(result.promptSection).toContain('Recovery handoff: We made the next step explicit.');
    expect(result.promptSection).toContain('Garden planning: We chose the first layout.');
    expect(result.promptSection).not.toContain('Cut episode');
    expect(result.promptSection).toContain('[episodic] The recovery plan still needs a follow-up.');
    expect(result.promptSection).toContain('[semantic] The garden layout should start with the shaded bed.');
    expect(result.promptSection).not.toContain('Foreign contact detail');
    expect(result.promptSection).not.toContain('Old detail');
    expect(result.provenanceRefs).toEqual(expect.arrayContaining([
      'session_message:discord:primary|entry:2',
      'episode:episode-1',
      'memory:memory-1',
    ]));
    expect(searchByTime).toHaveBeenCalledWith(expect.objectContaining({
      from: '2026-08-03T10:00:00.000Z',
      to: '2026-08-04T10:00:00.000Z',
      spanSessionId: 'discord:primary',
      order: 'desc',
    }));
    expect(listActiveMemories).toHaveBeenCalledWith({ limit: 50 });
  });

  it('emits explicit degradation when no day evidence is available', async () => {
    const result = await collectDailyReviewEvidence({
      nowMs: NOW_MS,
      windowMs: WINDOW_MS,
      scope: SCOPE,
      sessionManager: { getRecentMessages: () => [] },
      episodicStore: { searchByTime: async () => [] },
      memoryStore: { listActiveMemories: async () => [] },
    });

    expect(result.degraded).toBe(true);
    expect(result.promptSection).toContain('[Daily Evidence Grounding Degraded]');
    expect(result.promptSection).toContain('not evidence that nothing happened');
    expect(result.provenanceRefs).toEqual([]);
    expect(result.degradationReasons).toEqual(['no_bounded_day_evidence']);
  });

  it('keeps available evidence but marks a source failure as degraded', async () => {
    const warn = vi.fn();
    const result = await collectDailyReviewEvidence({
      nowMs: NOW_MS,
      windowMs: WINDOW_MS,
      scope: SCOPE,
      sessionManager: {
        getRecentMessages: () => [sessionEntry({ id: 9, content: 'A grounded conversation marker' })],
      },
      episodicStore: { searchByTime: async () => { throw new Error('episode store unavailable'); } },
      memoryStore: { listActiveMemories: async () => [] },
      logger: { warn },
    });

    expect(result.promptSection).toContain('A grounded conversation marker');
    expect(result.promptSection).toContain('[Daily Evidence Grounding Degraded]');
    expect(result.degraded).toBe(true);
    expect(result.degradationReasons).toEqual(['episode_read_failed']);
    expect(warn).toHaveBeenCalledWith(
      'Daily-review episode evidence read failed',
      expect.objectContaining({ error: 'Error: episode store unavailable' }),
    );
  });
});
