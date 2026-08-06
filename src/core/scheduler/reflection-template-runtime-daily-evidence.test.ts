import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { InternalStateComputer, buildInternalStateSnapshotRef } from '../self-model/state.js';
import { ReflectionMetacognitionJournalStore } from '../../persistence/journals/reflection-metacognition-journal.js';
import {
  resolveReflectionMetacognitionJournalPath,
} from '../../persistence/layout.js';
import type { ReflectionAgent } from './reflection-runtime-contracts.js';
import { createReflectionTemplateRuntime } from './reflection-template-runtime.js';
import { Scheduler } from './scheduler.js';

describe('daily-review deterministic evidence integration', () => {
  let tempDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('feeds a recorded conversation day, episodes, and memory deltas into the reflection and persists their refs', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'reflection-daily-evidence-'));
    const nowMs = Date.parse('2026-08-04T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const capturedPrompts: string[] = [];
    const handleMessage = vi.fn<ReflectionAgent['handleMessage']>(async (message) => {
      capturedPrompts.push(message.content);
      return {
        content: 'The recovery-plan conversation and garden layout both stood out today.',
      };
    });
    const currentInternalState = new InternalStateComputer().computeState({
      emotionState: {
        vad: { valence: 0.1, arousal: 0.1, dominance: 0.1 },
        mood: { valence: 0.1, arousal: 0.1, dominance: 0.1 },
        discrete: { curiosity: 0.4 },
        confidence: 0.8,
      },
      activeConcerns: [],
      trustLevel: 'trusted',
      contactId: 'contact-1',
      sessionMetrics: {
        userMessageText: 'We revisited the recovery plan.',
        responseText: 'The next step is explicit.',
        toolCallCount: 0,
        recentTurnCount: 4,
        lastSeenDeltaSeconds: 60,
      },
    });
    const snapshotRef = buildInternalStateSnapshotRef(currentInternalState);
    const runtime = createReflectionTemplateRuntime({
      scheduler: new Scheduler(new EventBus(), {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      }),
      agentLoop: {
        handleMessage,
        getCurrentInternalState: () => currentInternalState,
        getCurrentInternalStateSnapshotRef: () => snapshotRef,
        getCurrentMetacognitiveFlags: () => [],
      },
      dataDir: tempDir,
      runtimeOptions: {
        sessionManager: {
          resolveSessionChannelId: channelId => channelId,
          getRecentMessages: channelId => channelId === 'discord:primary'
            ? [
              {
                id: 41,
                channelId,
                role: 'user',
                authorName: 'Ari',
                content: 'We revisited the recovery plan and made the next step explicit.',
                timestamp: nowMs - 12 * 60 * 60 * 1000,
              },
              {
                id: 42,
                channelId,
                role: 'assistant',
                authorName: 'Purrsephone',
                content: 'Then we chose the shaded bed for the garden layout.',
                timestamp: nowMs - 2 * 60 * 60 * 1000,
              },
            ]
            : [],
        },
        contactStore: {
          getById: async () => ({
            id: 'contact-1',
            displayName: 'Ari',
            trustLevel: 'trusted',
            relationshipType: 'friend',
            firstSeen: '2026-01-01T00:00:00.000Z',
            lastSeen: '2026-08-04T09:59:00.000Z',
            conversationChannels: [{
              channel: 'discord',
              channelId: 'discord:primary',
              firstSeen: '2026-01-01T00:00:00.000Z',
              lastSeen: '2026-08-04T09:59:00.000Z',
            }],
          }),
          getEmotionalSnapshot: async () => null,
          getEmotionalTimeSeries: async () => [],
        },
        episodicReviewStore: {
          searchByTime: async () => [{
            schemaVersion: 2,
            id: 'episode-recovery',
            title: 'Recovery handoff',
            landmark: 'The next action became explicit.',
            startedAt: '2026-08-03T21:00:00.000Z',
            endedAt: '2026-08-03T22:00:00.000Z',
            participantContactIds: ['contact-1'],
            salience: { score: 0.8 },
            affect: { labels: [] },
            themes: ['recovery'],
            spanRefs: [{ spanId: 'span-recovery', sessionId: 'discord:primary' }],
            artifactRefs: [],
            provenanceRefs: [],
            createdAt: '2026-08-03T22:00:00.000Z',
            updatedAt: '2026-08-03T22:00:00.000Z',
          }],
        },
        memoryMaintenanceStore: {
          listActiveMemories: async () => [{
            id: 'memory-garden',
            text: 'The garden layout starts with the shaded bed.',
            type: 'semantic',
            importance: 0.7,
            confidence: 0.9,
            emotionalValence: 0.1,
            salience: 0.7,
            sourceRef: 'source:turn',
            extractedAt: nowMs - 60 * 60 * 1000,
            lastAccessed: nowMs - 60 * 60 * 1000,
            accessCount: 0,
            tags: [],
            sensitivity: 'personal',
            contactId: 'contact-1',
            provenance: { channelId: 'discord:primary' },
          }],
          upsertMemoryMaintenanceReview: vi.fn(),
          getById: vi.fn(),
          getMemoryMaintenanceDiagnostics: vi.fn(),
        },
      },
    });

    const result = await runtime.runTemplateNow('daily-review', { deferIfBusy: false });

    expect(result.reflection).toContain('recovery-plan conversation and garden layout');
    expect(handleMessage).toHaveBeenCalledOnce();
    expect(capturedPrompts[0]).toContain('[Deterministic Day Evidence]');
    expect(capturedPrompts[0]).toContain('2 recorded conversation messages');
    expect(capturedPrompts[0]).toContain('We revisited the recovery plan');
    expect(capturedPrompts[0]).toContain('Recovery handoff: The next action became explicit.');
    expect(capturedPrompts[0]).toContain('[semantic] The garden layout starts with the shaded bed.');
    expect(capturedPrompts[0]).not.toContain('[Daily Evidence Grounding Degraded]');

    const metacognitionEntry = new ReflectionMetacognitionJournalStore(
      resolveReflectionMetacognitionJournalPath(tempDir),
    ).listRecent({ limit: 1 })[0];
    expect(metacognitionEntry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
      'session_message:discord:primary|entry:41',
      'episode:episode-recovery',
      'memory:memory-garden',
    ]));
    expect(metacognitionEntry.metacognitiveFlags ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ flag: 'daily_review_evidence_degraded' }),
    ]));
  });
});
