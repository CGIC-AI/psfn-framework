import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../agent/contracts.js';
import { EventBus } from '../../shared/event-bus.js';
import { ReflectionJournalStore } from '../../persistence/journals/reflection-journal.js';
import { InternalStateComputer, buildInternalStateSnapshotRef } from '../self-model/state.js';
import {
  resolveHeartbeatPolicyPath,
  resolveReflectionJournalPath,
  resolveReflectionMetacognitionJournalPath,
} from '../../persistence/layout.js';
import { HeartbeatPolicyStore } from './heartbeat-policy.js';
import { Scheduler } from './scheduler.js';
import { createHeartbeatTemplateRuntime } from './heartbeat-template-runtime.js';

describe('createHeartbeatTemplateRuntime reflection metacognition journal', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records manual deliberation runs with provenance and process ids', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const reflectionJournalPrototype = ReflectionJournalStore.prototype as ReflectionJournalStore & {
      listRecent?: (options?: { limit?: number }) => unknown[];
    };
    const originalListRecent = reflectionJournalPrototype.listRecent;
    reflectionJournalPrototype.listRecent = () => [];

    try {
      const policyStore = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
      const policy = policyStore.load();
      const valuesTemplate = policy.templates.find((template) => template.id === 'values-reflection');
      expect(valuesTemplate).toBeDefined();
      if (!valuesTemplate) {
        throw new Error('values-reflection template missing from defaults');
      }
      valuesTemplate.deliberation = {
        ...valuesTemplate.deliberation,
        maxRounds: 1,
      };
      policyStore.save(policy);

      const internalState = new InternalStateComputer().computeState({
        emotionState: {
          vad: { valence: 0.1, arousal: 0.2, dominance: 0.05 },
          mood: { valence: 0.15, arousal: 0.25, dominance: 0.1 },
          discrete: { curiosity: 0.55, calm: 0.45 },
          confidence: 0.8,
        },
        activeConcerns: [],
        trustLevel: 'trusted',
        contactId: 'contact-1',
        sessionMetrics: {
          userMessageText: 'What matters right now?',
          responseText: 'Care and continuity matter.',
          toolCallCount: 0,
          recentTurnCount: 2,
          lastSeenDeltaSeconds: 90,
        },
      });
      const snapshotRef = buildInternalStateSnapshotRef(internalState);
      const metacognitiveFlags = [{ flag: 'continuity', confidence: 0.72 }];
      const llmProvider: LLMProviderPort = {
        stream: vi.fn(async () => ({
          content: '',
          toolCalls: [],
          model: 'mock-stream',
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'stop',
        })),
        complete: vi.fn(async (_context, purpose) => {
          const content = purpose === 'reasoning'
            ? 'Continuity stays central.'
            : 'Care keeps the tone steady.';
          return {
            content,
            toolCalls: [],
            model: `mock-${purpose}`,
            inputTokens: 12,
            outputTokens: 18,
            stopReason: 'stop',
          };
        }),
      };

      const runtime = createHeartbeatTemplateRuntime({
        scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
        agentLoop: {
          handleMessage: vi.fn(async () => ({ content: 'unused' })),
          getCurrentInternalState: () => internalState,
          getCurrentInternalStateSnapshotRef: () => snapshotRef,
          getCurrentMetacognitiveFlags: () => metacognitiveFlags,
        },
        sender: { send: vi.fn(async () => undefined) },
        dataDir: tempDir,
        runtimeOptions: {
          llmProvider: llmProvider as any,
        },
      });

      await runtime.runTemplateNow('values-reflection', {
        sendToDiscordOverride: false,
        deferIfBusy: false,
      });

      const raw = readFileSync(resolveReflectionMetacognitionJournalPath(tempDir), 'utf-8').trim();
      const entry = JSON.parse(raw.split('\n').at(-1) ?? '{}') as {
        kind: string;
        executionSource: string;
        initiatorSurface: string;
        initiatedBy: string;
        reason?: string;
        processId?: string;
        internalStateSnapshotRef?: string;
        metacognitiveFlags?: Array<{ flag: string; confidence: number }>;
        reflectionJournalEntryId?: string;
        dailyJournalEntryId?: string;
      };

      expect(entry.kind).toBe('reflection_run');
      expect(entry.executionSource).toBe('manual');
      expect(entry.initiatorSurface).toBe('tool:heartbeat_run_template');
      expect(entry.initiatedBy).toBe('companion');
      expect(entry.reason).toBe('Manual reflection run via heartbeat_run_template');
      expect(entry.processId).toMatch(/^reflection-process-/);
      expect(entry.internalStateSnapshotRef).toBe(snapshotRef);
      expect(entry.metacognitiveFlags).toEqual(metacognitiveFlags);
      expect(entry.reflectionJournalEntryId).toBeDefined();
      expect(entry.dailyJournalEntryId).toBeDefined();
    } finally {
      if (originalListRecent === undefined) {
        delete reflectionJournalPrototype.listRecent;
      } else {
        reflectionJournalPrototype.listRecent = originalListRecent;
      }
    }
  });

  it('does not inject appearance context into deliberation heartbeat prompts', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const capturedPrompts: string[] = [];
    const reflectionJournalPrototype = ReflectionJournalStore.prototype as ReflectionJournalStore & {
      listRecent?: (options?: { limit?: number }) => unknown[];
    };
    const originalListRecent = reflectionJournalPrototype.listRecent;
    reflectionJournalPrototype.listRecent = () => [];
    const policyStore = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
    try {
      const policy = policyStore.load();
      const valuesTemplate = policy.templates.find((template) => template.id === 'values-reflection');
      expect(valuesTemplate).toBeDefined();
      if (!valuesTemplate) {
        throw new Error('values-reflection template missing from defaults');
      }
      valuesTemplate.deliberation = {
        ...valuesTemplate.deliberation,
        maxRounds: 1,
      };
      policyStore.save(policy);

      const internalState = new InternalStateComputer().computeState({
        emotionState: {
          vad: { valence: 0.1, arousal: 0.2, dominance: 0.05 },
          mood: { valence: 0.15, arousal: 0.25, dominance: 0.1 },
          discrete: { curiosity: 0.55, calm: 0.45 },
          confidence: 0.8,
        },
        activeConcerns: [],
        trustLevel: 'trusted',
        contactId: 'contact-1',
        sessionMetrics: {
          userMessageText: 'What matters right now?',
          responseText: 'Care and continuity matter.',
          toolCallCount: 0,
          recentTurnCount: 2,
          lastSeenDeltaSeconds: 90,
        },
      });
      const snapshotRef = buildInternalStateSnapshotRef(internalState);
      const llmProvider: LLMProviderPort = {
        stream: vi.fn(async () => ({
          content: '',
          toolCalls: [],
          model: 'mock-stream',
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'stop',
        })),
        complete: vi.fn(async (context, purpose) => {
          capturedPrompts.push(
            context.messages
              .map((message) => message.content)
              .join('\n'),
          );
          return {
            content: purpose === 'reasoning'
              ? 'Continuity stays central.'
              : 'Care keeps the tone steady.',
            toolCalls: [],
            model: `mock-${purpose}`,
            inputTokens: 12,
            outputTokens: 18,
            stopReason: 'stop',
          };
        }),
      };

      const runtime = createHeartbeatTemplateRuntime({
        scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
        agentLoop: {
          handleMessage: vi.fn(async () => ({ content: 'unused' })),
          getCurrentInternalState: () => internalState,
          getCurrentInternalStateSnapshotRef: () => snapshotRef,
          getCurrentMetacognitiveFlags: () => [],
        },
        sender: { send: vi.fn(async () => undefined) },
        dataDir: tempDir,
        runtimeOptions: {
          llmProvider: llmProvider as any,
          characterPromptVariablesProvider: () => ({
            'character.visual_description': 'Silver eyes and a weathered jacket.',
          }),
        },
      });

      await runtime.runTemplateNow('values-reflection', {
        sendToDiscordOverride: false,
        deferIfBusy: false,
      });

      expect(capturedPrompts.length).toBeGreaterThan(0);
      for (const prompt of capturedPrompts) {
        expect(prompt).not.toContain('Appearance context:');
        expect(prompt).not.toContain('Silver eyes and a weathered jacket.');
      }
    } finally {
      if (originalListRecent === undefined) {
        delete reflectionJournalPrototype.listRecent;
      } else {
        reflectionJournalPrototype.listRecent = originalListRecent;
      }
    }
  });

  it.each(['daily-review', 'musing'])(
    'binds canonical contact context for %s reflection turns',
    async (templateId) => {
      tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
      const capturedPrompts: string[] = [];
      const recentSessionMessages = [
        {
          id: 1,
          channelId: 'discord:primary-session',
          role: 'user' as const,
          content: 'I was here yesterday.',
          timestamp: 1_700_000_000_000,
          authorName: 'Ari',
        },
        {
          id: 2,
          channelId: 'discord:primary-session',
          role: 'assistant' as const,
          content: 'I remember that contact.',
          timestamp: 1_700_000_000_100,
          authorName: 'Companion',
        },
      ];
      const memoryRetrieve = vi.fn(async () => '[Reflection Memory Retrieval]\n- trust-filtered contact memory');
      const currentContact = {
        id: 'contact-1',
        displayName: 'Ari',
        nickname: 'Ari',
        trustLevel: 'trusted' as const,
        relationshipType: 'friend' as const,
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-03-31T12:00:00.000Z',
        conversationChannels: [{
          channel: 'discord',
          channelId: 'discord:primary-session',
          firstSeen: '2026-01-01T00:00:00.000Z',
          lastSeen: '2026-03-31T12:00:00.000Z',
        }],
      };
      const currentInternalState = new InternalStateComputer().computeState({
        emotionState: {
          vad: { valence: 0.2, arousal: 0.15, dominance: 0.1 },
          mood: { valence: 0.25, arousal: 0.2, dominance: 0.15 },
          discrete: { curiosity: 0.5, calm: 0.4 },
          confidence: 0.75,
        },
        activeConcerns: [],
        trustLevel: 'trusted',
        contactId: 'contact-1',
        sessionMetrics: {
          userMessageText: 'Recent conversations matter.',
          responseText: 'Keep continuity with the primary contact.',
          toolCallCount: 0,
          recentTurnCount: 3,
          lastSeenDeltaSeconds: 120,
        },
      });
      const currentSnapshotRef = buildInternalStateSnapshotRef(currentInternalState);
      const handleMessage = vi.fn(async (message) => {
        capturedPrompts.push(message.content);
        const responseInternalState = new InternalStateComputer().computeState({
          emotionState: {
            vad: { valence: 0.2, arousal: 0.15, dominance: 0.1 },
            mood: { valence: 0.25, arousal: 0.2, dominance: 0.15 },
            discrete: { curiosity: 0.5, calm: 0.4 },
            confidence: 0.75,
          },
          activeConcerns: [],
          trustLevel: 'primary',
          contactId: message.routing?.canonicalContactId ?? message.authorId,
          sessionMetrics: {
            userMessageText: message.content,
            responseText: 'Bound reflection',
            toolCallCount: 0,
            recentTurnCount: 1,
            lastSeenDeltaSeconds: 30,
          },
        });
        return {
          content: 'Bound reflection',
          metadata: {
            internalState: responseInternalState,
            internalStateSnapshotRef: buildInternalStateSnapshotRef(responseInternalState),
            metacognitiveFlags: [],
          },
        };
      });

      const runtime = createHeartbeatTemplateRuntime({
        scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
        agentLoop: {
          handleMessage,
          memoryProvider: {
            retrieve: memoryRetrieve,
          },
          getCurrentInternalState: () => currentInternalState,
          getCurrentInternalStateSnapshotRef: () => currentSnapshotRef,
          getCurrentMetacognitiveFlags: () => [],
        } as any,
        sender: { send: vi.fn(async () => undefined) },
        dataDir: tempDir,
        runtimeOptions: {
          sessionManager: {
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: (channelId: string, limit?: number) => (
              channelId === 'discord:primary-session'
                ? recentSessionMessages.slice(0, limit ?? recentSessionMessages.length)
                : []
            ),
          },
          contactStore: {
            getById: async (id: string) => (id === 'contact-1' ? currentContact : undefined),
            getEmotionalSnapshot: async (id: string) => (
              id === 'contact-1'
                ? { valence: 0.18, confidence: 0.84, observedAtMs: 1_700_000_000_000 }
                : undefined
            ),
          },
          getActiveConcerns: async ({ canonicalContactKey }) => (
            canonicalContactKey === 'contact-1'
              ? [{
                id: 'concern-1',
                title: 'Clarify the recovery timeline',
                summary: 'Keep the follow-up explicit.',
                status: 'open',
                dueAt: Date.parse('2026-04-01T12:00:00.000Z'),
                priority: 'high',
              }]
              : []
          ),
          pendingFollowUpStore: {
            getPendingFollowUps: async (contactId?: string) => (
              contactId === 'contact-1'
                ? [{
                  id: 'follow-up-1',
                  content: 'Check in about the recovery plan',
                  priority: 'medium',
                  timing: 'soon',
                  dueAt: '2026-04-01T09:00:00.000Z',
                  contextSummary: 'Follow up on recovery',
                  wakeConditions: ['next_user_turn'],
                }]
                : []
            ),
          } as any,
        },
      });

      await runtime.runTemplateNow(templateId, {
        sendToDiscordOverride: false,
        deferIfBusy: false,
      });

      expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({
        channelId: `internal:reflection:${templateId}`,
        authorId: 'contact-1',
        routing: expect.objectContaining({
          canonicalContactId: 'contact-1',
        }),
      }));
      expect(capturedPrompts[0]).toContain('[Reflection Contact Context]');
      expect(capturedPrompts[0]).toContain('recent_contact_status: active');
      expect(capturedPrompts[0]).toContain('I was here yesterday.');
      expect(capturedPrompts[0]).toContain('trust-filtered contact memory');
      expect(capturedPrompts[0]).not.toContain('stale silence');
      expect(memoryRetrieve).toHaveBeenCalled();
      expect(memoryRetrieve.mock.calls[0]?.[1]).toBe(`internal:reflection:${templateId}`);
      expect(memoryRetrieve.mock.calls[0]?.[4]).toBe('contact-1');
      expect(memoryRetrieve.mock.calls[0]?.[9]).toEqual({ retrievalMode: 'reflection' });

      const raw = readFileSync(resolveReflectionJournalPath(tempDir), 'utf-8').trim();
      const entry = JSON.parse(raw.split('\n').at(-1) ?? '{}') as {
        telemetry?: {
          narrativeContext?: {
            internalState?: {
              relational?: {
                contactId?: string | null;
              };
            };
          };
        };
      };
      expect(entry.telemetry?.narrativeContext?.internalState?.relational?.contactId).toBe('contact-1');
    },
  );
});
