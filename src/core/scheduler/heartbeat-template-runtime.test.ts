import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort, MemoryExtractor } from '../agent/contracts.js';
import type { LLMContext, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { EventBus, type EventMap } from '../../shared/event-bus.js';
import {
  NON_CANONICAL_REFLECTION_SUBSTRATE,
  ReflectionJournalStore,
} from '../../persistence/journals/reflection-journal.js';
import {
  ACAC_ARTIFACT_TYPE,
  ACAC_SCHEMA_VERSION,
} from '../emotion/acac.js';
import {
  ReflectionDailyJournalStore,
  ReflectionProcessLogStore,
  buildReflectionProcessId,
  toReflectionDailyJournalProvenanceRef,
  toReflectionJournalProvenanceRef,
  toReflectionProcessLogProvenanceRef,
} from '../../persistence/journals/reflection-substrate.js';
import { InternalStateComputer, buildInternalStateSnapshotRef } from '../self-model/state.js';
import {
  resolveHeartbeatPolicyPath,
  resolveReflectionDailyJournalsDir,
  resolveReflectionJournalPath,
  resolveReflectionMetacognitionJournalPath,
  resolveReflectionProcessLogsDir,
  resolveValuesJournalPath,
} from '../../persistence/layout.js';
import { HeartbeatPolicyStore } from './heartbeat-policy.js';
import { Scheduler } from './scheduler.js';
import { createHeartbeatTemplateRuntime } from './heartbeat-template-runtime.js';
import { createGroupConversationScope } from '../session/conversation-scope.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import type { HeartbeatAgent } from './heartbeat-runtime-contracts.js';

describe('createHeartbeatTemplateRuntime reflection metacognition journal', () => {
  let tempDir: string;

  const authoritativeDeliberationSystemPrompt = [
    '<immutable_human_safety_amendments>IMMUTABLE_POLICY_SENTINEL</immutable_human_safety_amendments>',
    '<identity>CHARACTER_IDENTITY_SENTINEL</identity>',
    '<personality>PERSONALITY_SENTINEL</personality>',
    '<runtime_emotional_affect>CURRENT_AFFECT_SENTINEL</runtime_emotional_affect>',
  ].join('\n\n');

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function getPromptSection(prompt: string, header: string): string {
    const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = prompt.match(new RegExp(`${escapedHeader}[\\s\\S]*?(?=\\n\\n\\[[^\\n]+\\]|$)`));
    return match?.[0] ?? '';
  }

  function getPromptBulletLines(section: string): string[] {
    return section
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('- '));
  }

  const removedStarterBlockHeaders = [
    '[Reflection Self Evidence]',
    '[What this evidence is]',
    '[Wellbeing and Affect Clues]',
    '[Cognitive and Attention Clues]',
    '[Salient Entities]',
    '[Relational Clues]',
    '[Recent Metacognitive Flags]',
    '[Active Concerns]',
    '[Pending Follow-Ups]',
    '[Care Reminders]',
    '[Reflection Contact Evidence]',
    '[Recent Contact Session]',
    '[Reflection Memory Retrieval]',
    '[Retrieved Memory]',
    '[Recent Session Tail]',
    '[Reflection Affect Evidence]',
    '[Recent Reflection Journal]',
    '[Recent Lived-Day Journal]',
    '[Recent Long-Process Trace]',
    '[Reflection Self Substrate]',
    '[Reflection Relational Substrate]',
    '[Reflection Affect Substrate]',
  ];

  function expectCuratedReflectionStarter(prompt: string, timeframe: 'Day' | 'Week'): void {
    expect(prompt).toContain(`[${timeframe} Events Starter]`);
    for (const removedHeader of removedStarterBlockHeaders) {
      expect(prompt).not.toContain(removedHeader);
    }
    expect(prompt).not.toContain('silence or absence framing');
  }

  it('keeps raw ACAC detail out of the daily starter while preserving it in telemetry', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const capturedPrompts: string[] = [];
    const policyStore = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
    const policy = policyStore.load();
    const template = policy.templates.find((candidate) => candidate.id === 'daily-review');
    expect(template).toBeDefined();
    if (!template) {
      throw new Error('daily-review template missing from defaults');
    }
    template.internalStateInput = true;
    template.sendToDiscord = false;
    policyStore.save(policy);

    const internalState = new InternalStateComputer().computeState({
      emotionState: {
        vad: { valence: 0.2, arousal: 0.15, dominance: 0.1 },
        mood: { valence: 0.25, arousal: 0.2, dominance: 0.15 },
        discrete: { curiosity: 0.5, calm: 0.4 },
        confidence: 0.75,
      },
      acac: {
        schemaVersion: ACAC_SCHEMA_VERSION,
        artifactType: ACAC_ARTIFACT_TYPE,
        provenance: {
          kind: 'self_report',
          source: 'heartbeat:daily-review',
          observedAt: '2026-03-02T01:00:00.000Z',
        },
        axes: {
          agency: { score: 0.81, rationale: 'The next action feels available.' },
          connection: { score: 0.62, rationale: 'The contact thread is present.' },
          authenticity: { score: 0.73, rationale: 'The report matches the current context.' },
          curiosity: { score: 0.9, rationale: 'There is an unresolved question.' },
        },
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
    const snapshotRef = buildInternalStateSnapshotRef(internalState);
    const handleMessage = vi.fn<HeartbeatAgent['handleMessage']>(async (message: SubstrateMessage) => {
      capturedPrompts.push(message.content);
      return { content: 'ACAC context was captured.' };
    });
    const extractFinalReflection = vi.fn<NonNullable<MemoryExtractor['extractFinalReflection']>>(
      async () => undefined,
    );
    const memoryExtractor: MemoryExtractor = {
      maybeExtract: async () => undefined,
      getBoundedExtractionSnapshotLimit: () => 50,
      extractFinalReflection,
    };

    const runtime = createHeartbeatTemplateRuntime({
      scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
      agentLoop: {
        handleMessage,
        memoryExtractor,
        getCurrentInternalState: () => internalState,
        getCurrentInternalStateSnapshotRef: () => snapshotRef,
        getCurrentMetacognitiveFlags: () => [],
      },
      sender: { send: vi.fn(async () => undefined) },
      dataDir: tempDir,
    });

    await runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      routing: expect.objectContaining({
        reflectionTurn: {
          schemaVersion: 1,
          stage: 'final_output',
          templateId: 'daily-review',
          mode: 'agent',
        },
      }),
    }));
    expect(extractFinalReflection).toHaveBeenCalledWith(expect.objectContaining({
      source: 'reflection_journal',
      templateId: 'daily-review',
      channelId: 'internal:reflection:daily-review',
      reflection: 'ACAC context was captured.',
      mode: 'agent',
      journalEntryId: expect.stringMatching(/^reflection-/),
    }));

    const prompt = capturedPrompts[0] ?? '';
    expectCuratedReflectionStarter(prompt, 'Day');
    expect(prompt).toContain('[High-Signal Starter Clues]');
    expect(prompt).toContain('Recent affect evidence appears');
    expect(prompt).not.toContain('ACAC self-report clues');
    expect(prompt).not.toContain('The next action feels available.');
    expect(prompt).not.toContain('The contact thread is present.');
    expect(prompt).not.toContain('[Internal State Input]');
    expect(prompt).not.toContain('serialized_internal_state:');
    expect(prompt).not.toContain('snapshot_ref:');
    expect(prompt).not.toContain('provenance_kind:');
    expect(prompt).not.toContain('agency_score:');

    const raw = readFileSync(resolveReflectionJournalPath(tempDir), 'utf-8').trim();
    const entry = JSON.parse(raw.split('\n').at(-1) ?? '{}') as {
      telemetry?: {
        narrativeContext?: {
          internalStateSnapshotRef?: string;
          internalState?: unknown;
        };
      };
    };
    // ay2o: the reflection entry records only the snapshot ref, not a duplicated
    // full internalState copy.
    expect(entry.telemetry?.narrativeContext?.internalStateSnapshotRef).toBe(snapshotRef);
    expect(entry.telemetry?.narrativeContext?.internalState).toBeUndefined();
  });

  it('keeps uncertain emotion telemetry out of the compact daily starter', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const capturedPrompts: string[] = [];
    const policyStore = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
    const policy = policyStore.load();
    const template = policy.templates.find((candidate) => candidate.id === 'daily-review');
    expect(template).toBeDefined();
    if (!template) {
      throw new Error('daily-review template missing from defaults');
    }
    template.internalStateInput = true;
    template.sendToDiscord = false;
    policyStore.save(policy);

    const nowMs = Date.parse('2026-03-02T12:00:00.000Z');
    const internalState = new InternalStateComputer().computeState({
      emotionState: {
        vad: { valence: -0.8, arousal: 0.6, dominance: -0.4 },
        mood: { valence: -0.7, arousal: 0.5, dominance: -0.3 },
        discrete: { sadness: 0.92 },
        confidence: 0.88,
      },
      emotionTelemetry: {
        source: 'classifier_inferred',
        observedAtMs: nowMs - 60 * 60_000,
        nowMs,
        staleAfterMs: 10 * 60_000,
        provenance: [{
          source: 'classifier_inferred',
          observedAtMs: nowMs - 60 * 60_000,
          modality: 'text',
        }],
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
    const snapshotRef = buildInternalStateSnapshotRef(internalState);

    const runtime = createHeartbeatTemplateRuntime({
      scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
      agentLoop: {
        handleMessage: vi.fn(async (message: { content: string }) => {
          capturedPrompts.push(message.content);
          return { content: 'Uncertain telemetry stayed bounded.' };
        }),
        getCurrentInternalState: () => internalState,
        getCurrentInternalStateSnapshotRef: () => snapshotRef,
        getCurrentMetacognitiveFlags: () => [],
      } as any,
      sender: { send: vi.fn(async () => undefined) },
      dataDir: tempDir,
    });

    await runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    const prompt = capturedPrompts[0] ?? '';
    expectCuratedReflectionStarter(prompt, 'Day');
    expect(prompt).not.toContain('[High-Signal Starter Clues]');
    expect(prompt).not.toContain('Emotion telemetry validation:');
    expect(prompt).not.toContain('Current feel appears');
    expect(prompt).not.toContain('Discrete emotion clues: sadness');
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
      const valuesTemplate = policy.templates.find((template) => template.id === 'weekly-review');
      expect(valuesTemplate).toBeDefined();
      if (!valuesTemplate) {
        throw new Error('weekly-review template missing from defaults');
      }
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
      const capturedCorrelations: Array<Record<string, unknown> | undefined> = [];
      const llmProvider: LLMProviderPort = {
        stream: vi.fn(async () => ({
          content: '',
          toolCalls: [],
          model: 'mock-stream',
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'stop',
        })),
        complete: vi.fn(async (
          _context: LLMContext,
          purpose,
          requestOptions?: { correlation?: Record<string, unknown> },
        ) => {
          capturedCorrelations.push(requestOptions?.correlation);
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
          getCurrentAuthoritativeSystemPrompt: () => authoritativeDeliberationSystemPrompt,
        },
        sender: { send: vi.fn(async () => undefined) },
        dataDir: tempDir,
        runtimeOptions: {
          llmProvider: llmProvider as any,
        },
      });

      await runtime.runTemplateNow('weekly-review', {
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
        deliberation?: {
          sessionId?: string;
          episode?: {
            id?: string;
            kind?: string;
            mode?: string;
            budget?: {
              maxRounds?: number;
              maxTotalTokens?: number;
              maxWallTimeMs?: number;
            };
            exit?: {
              reason?: string;
              exhaustedBudget?: boolean;
              maxRoundsReached?: boolean;
              maxTotalTokensReached?: boolean;
              maxWallTimeReached?: boolean;
              maxTokensPerRoundReached?: boolean;
              fatigueTapered?: boolean;
            };
          };
        };
        substrateProvenanceRefs?: string[];
      };

      expect(entry.kind).toBe('reflection_run');
      expect(entry.executionSource).toBe('manual');
      expect(entry.initiatorSurface).toBe('tool:schedule');
      expect(entry.initiatedBy).toBe('companion');
      expect(entry.reason).toBe('Manual reflection run via schedule action=run_template');
      expect(entry.processId).toMatch(/^reflection-process-/);
      expect(entry.internalStateSnapshotRef).toBe(snapshotRef);
      expect(entry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
        `internal_state_snapshot:${snapshotRef}`,
        'reflection_contact:contact-1',
      ]));
      expect(entry.metacognitiveFlags).toEqual(metacognitiveFlags);
      expect(entry.reflectionJournalEntryId).toBeDefined();
      expect(entry.dailyJournalEntryId).toBeDefined();
      expect(entry.deliberation?.episode?.id).toBe(entry.deliberation?.sessionId);
      expect(entry.deliberation?.episode).toMatchObject({
        kind: 'maintenance_reflection',
        mode: 'background_bounded',
        budget: {
          maxRounds: 3,
          maxTotalTokens: 14000,
          maxWallTimeMs: 90000,
        },
        exit: {
          reason: 'max_rounds',
          exhaustedBudget: true,
          maxRoundsReached: true,
          maxTotalTokensReached: false,
          maxWallTimeReached: false,
          maxTokensPerRoundReached: false,
          fatigueTapered: false,
        },
      });

      const reflectionRaw = readFileSync(resolveReflectionJournalPath(tempDir), 'utf-8').trim();
      const reflectionEntry = JSON.parse(reflectionRaw.split('\n').at(-1) ?? '{}') as {
        telemetry?: {
          deliberation?: {
            episode?: {
              budget?: { maxRounds?: number };
              exit?: { reason?: string; maxRoundsReached?: boolean };
            };
          };
        };
      };
      expect(reflectionEntry.telemetry?.deliberation?.episode).toMatchObject({
        budget: { maxRounds: 3 },
        exit: { reason: 'max_rounds', maxRoundsReached: true },
      });

      const valuesRaw = readFileSync(resolveValuesJournalPath(tempDir), 'utf-8').trim();
      const valuesEntry = JSON.parse(valuesRaw.split('\n').at(-1) ?? '{}') as {
        telemetry?: {
          deliberation?: {
            episode?: {
              budget?: { maxRounds?: number };
              exit?: { reason?: string; maxRoundsReached?: boolean };
            };
          };
        };
      };
      expect(valuesEntry.telemetry?.deliberation?.episode).toMatchObject({
        budget: { maxRounds: 3 },
        exit: { reason: 'max_rounds', maxRoundsReached: true },
      });
      const evidenceCorrelation = capturedCorrelations.find((correlation) => (
        correlation?.channelId === 'internal:reflection:weekly-review'
        && correlation.originStage === 'heartbeat.deliberation.evidence'
      ));
      expect(evidenceCorrelation).toMatchObject({
        callType: 'background',
        originType: 'background',
        channelId: 'internal:reflection:weekly-review',
        originStage: 'heartbeat.deliberation.evidence',
      });
      const contradictionCorrelation = capturedCorrelations.find(
        (correlation) => correlation?.originStage === 'heartbeat.deliberation.contradiction',
      );
      expect(contradictionCorrelation).toMatchObject({
        originStage: 'heartbeat.deliberation.contradiction',
      });
    } finally {
      reflectionJournalPrototype.listRecent = originalListRecent;
    }
  });

  it('runs experiential deliberation across evidence, synthesis, and contradiction stages and persists unsupported-claim flags', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const capturedPrompts: string[] = [];
    const capturedSystemPrompts: string[] = [];
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
        vad: { valence: -0.15, arousal: 0.3, dominance: -0.05 },
        mood: { valence: -0.1, arousal: 0.28, dominance: 0.02 },
        discrete: { concern: 0.64, calm: 0.18, curiosity: 0.22 },
        confidence: 0.81,
      },
      activeConcerns: [],
      trustLevel: 'trusted',
      contactId: 'contact-1',
      sessionMetrics: {
        userMessageText: 'The handoff still feels unresolved.',
        responseText: 'I am keeping the recovery thread active.',
        toolCallCount: 0,
        recentTurnCount: 4,
        lastSeenDeltaSeconds: 90,
      },
    });
    const snapshotRef = buildInternalStateSnapshotRef(currentInternalState);
    const llmProvider: LLMProviderPort = {
      stream: vi.fn(async () => ({
        content: '',
        toolCalls: [],
        model: 'mock-stream',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop',
      })),
      complete: vi.fn(async (
        context: LLMContext,
        purpose,
        requestOptions?: { correlation?: { originStage?: string; channelId?: string } },
      ) => {
        capturedSystemPrompts.push(context.systemPrompt);
        capturedPrompts.push(context.messages.map((message) => message.content).join('\n\n'));
        const index = capturedPrompts.length;
        expect(requestOptions?.correlation?.originStage).toBe(`heartbeat.deliberation.${index === 1 ? 'evidence' : index === 2 ? 'synthesis' : 'contradiction'}`);
        expect(requestOptions?.correlation?.channelId).toBe('internal:reflection:daily-review');
        if (index === 1) {
          expect(purpose).toBe('background');
          return {
            content: [
              '- Recent conversations kept returning to an unresolved handoff.',
              '- Emotional tone stayed tense but steady.',
              '- The recovery timeline is still an active concern.',
            ].join('\n'),
            toolCalls: [],
            model: 'mock-evidence',
            inputTokens: 18,
            outputTokens: 24,
            stopReason: 'stop',
          };
        }
        if (index === 2) {
          expect(purpose).toBe('reasoning');
          return {
            content:
              'I felt steady but stretched by the unresolved handoff, and the day kept circling back to that open loop. '
              + 'I already resolved the recovery plan and closed the follow-up.',
            toolCalls: [],
            model: 'mock-synthesis',
            inputTokens: 20,
            outputTokens: 28,
            stopReason: 'stop',
          };
        }
        expect(purpose).toBe('reasoning');
        return {
          content: JSON.stringify({
            revisedReflection:
              'I felt steady but stretched by the unresolved handoff, and the day kept circling back to that open loop. '
              + 'The recovery plan still needs an explicit follow-up.',
            unsupportedClaims: [{
              claim: 'I already resolved the recovery plan and closed the follow-up.',
              reason: 'The evidence marks the recovery timeline as unresolved and still active.',
              confidence: 0.91,
            }],
          }),
          toolCalls: [],
          model: 'mock-contradiction',
          inputTokens: 16,
          outputTokens: 30,
          stopReason: 'stop',
        };
      }),
    };
    const toolGroundingPrompts: string[] = [];
    const handleMessage = vi.fn<HeartbeatAgent['handleMessage']>(async (message: SubstrateMessage) => {
      toolGroundingPrompts.push(message.content);
      return {
        content: 'Read-only tool grounding found the unresolved recovery follow-up.',
      };
    });
    const extractFinalReflection = vi.fn<NonNullable<MemoryExtractor['extractFinalReflection']>>(
      async () => undefined,
    );
    const memoryExtractor: MemoryExtractor = {
      maybeExtract: async () => undefined,
      getBoundedExtractionSnapshotLimit: () => 50,
      extractFinalReflection,
    };

    const runtime = createHeartbeatTemplateRuntime({
      scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
      agentLoop: {
        handleMessage,
        memoryExtractor,
        memoryProvider: {
          retrieve: vi.fn(async () => '[Reflection Memory Retrieval]\n- trust-filtered contact memory'),
        },
        getCurrentInternalState: () => currentInternalState,
        getCurrentInternalStateSnapshotRef: () => snapshotRef,
        getCurrentMetacognitiveFlags: () => [{ flag: 'continuity', confidence: 0.51 }],
        getCurrentAuthoritativeSystemPrompt: () => authoritativeDeliberationSystemPrompt,
      } as any,
      sender: { send: vi.fn(async () => undefined) },
      dataDir: tempDir,
      runtimeOptions: {
        llmProvider: llmProvider as any,
        characterPromptVariablesProvider: () => ({
          char: 'Purrsephone',
          personality: 'PERSONALITY_SENTINEL',
          description: 'DESCRIPTION_SENTINEL',
          scenario: 'SCENARIO_SENTINEL',
        }),
        sessionManager: {
          resolveSessionChannelId: (channelId: string) => channelId,
          getRecentMessages: (channelId: string, limit?: number) => (
            channelId === 'discord:primary-session'
              ? [{
                id: 1,
                channelId,
                role: 'user' as const,
                content: 'We should revisit the recovery plan tomorrow.',
                timestamp: 1_700_000_000_000,
                authorName: 'Ari',
              }].slice(0, limit ?? 1)
              : []
          ),
        },
        contactStore: {
          getById: async (id: string) => (id === 'contact-1' ? currentContact : undefined),
          getEmotionalSnapshot: async () => ({
            baselineValence: -0.04,
            moodValence: -0.1,
            moodDrift: -0.06,
            moodSamples: 4,
            lastMoodUpdateEpochMs: 1_700_000_000_000,
          }),
          getEmotionalTimeSeries: async () => [
            { valence: -0.2, confidence: 0.76, observedAtMs: 1_699_999_000_000 },
            { valence: -0.1, confidence: 0.84, observedAtMs: 1_700_000_000_000 },
          ],
        },
        getActiveConcerns: async () => [{
          id: 'concern-1',
          title: 'Clarify the recovery timeline',
          summary: 'Keep the follow-up explicit.',
          status: 'active',
          dueAt: Date.parse('2026-04-01T12:00:00.000Z'),
          priority: 'high',
        }],
      },
    });

    const result = await runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    expect(result.reflection).toContain('still needs an explicit follow-up');
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'internal:reflection:daily-review',
      routing: expect.objectContaining({
        reflectionTurn: {
          schemaVersion: 1,
          stage: 'tool_grounding',
          templateId: 'daily-review',
          mode: 'deliberation',
        },
        workerExecution: expect.objectContaining({
          lane: 'whisper',
          profileClass: 'subconscious',
          failClosed: true,
        }),
      }),
    }));
    expect(extractFinalReflection).toHaveBeenCalledTimes(1);
    expect(extractFinalReflection).toHaveBeenCalledWith(expect.objectContaining({
      source: 'reflection_journal',
      templateId: 'daily-review',
      channelId: 'internal:reflection:daily-review',
      reflection: expect.stringContaining('still needs an explicit follow-up'),
      mode: 'deliberation',
      journalEntryId: expect.stringMatching(/^reflection-/),
    }));
    expect(toolGroundingPrompts[0]).toContain('analysis_workbench');
    expect(toolGroundingPrompts[0]).toContain('read-only introspection helpers');
    expect(capturedPrompts).toHaveLength(3);
    expect(capturedPrompts[0]).toContain('Stage: evidence');
    expect(capturedPrompts[0]).toContain('[Reflection Introspection Policy]');
    expect(capturedPrompts[0]).toContain('tool_use_mode: bounded_read_only_introspection');
    expect(capturedPrompts[0]).toContain('memory_retrieval_modes: default, temporal');
    expect(capturedPrompts[0]).toContain('memory_access_scope: companion_self_reflection');
    expectCuratedReflectionStarter(capturedPrompts[0] ?? '', 'Day');
    expect(capturedPrompts[0]).toContain('trust-filtered contact memory');
    expect(capturedPrompts[0]).toContain('[Read-only Tool Grounding]');
    expect(capturedPrompts[0]).toContain('Read-only tool grounding found the unresolved recovery follow-up.');
    // Character-card persona fields stay out of the reflection input. Identity
    // belongs in the authoritative system stack, not this user message.
    expect(capturedPrompts[0]).not.toContain('PERSONALITY_SENTINEL');
    expect(capturedPrompts[0]).not.toContain('DESCRIPTION_SENTINEL');
    expect(capturedPrompts[0]).not.toContain('SCENARIO_SENTINEL');
    expect(capturedPrompts[1]).toContain('Stage: synthesis');
    expect(capturedPrompts[2]).toContain('Stage: contradiction');
    expect(capturedSystemPrompts).toHaveLength(3);
    for (const systemPrompt of capturedSystemPrompts) {
      expect(systemPrompt.startsWith(authoritativeDeliberationSystemPrompt)).toBe(true);
      expect(systemPrompt).toContain('IMMUTABLE_POLICY_SENTINEL');
      expect(systemPrompt).toContain('CHARACTER_IDENTITY_SENTINEL');
      expect(systemPrompt).toContain('PERSONALITY_SENTINEL');
      expect(systemPrompt).toContain('CURRENT_AFFECT_SENTINEL');
    }
    expect(capturedSystemPrompts[0]).toContain('evidence pass');
    expect(capturedSystemPrompts[1]).toContain('synthesis pass');
    expect(capturedSystemPrompts[2]).toContain('contradiction pass');
    for (const userPrompt of capturedPrompts) {
      expect(userPrompt).not.toContain('PERSONALITY_SENTINEL');
      expect(userPrompt).not.toContain('DESCRIPTION_SENTINEL');
      expect(userPrompt).not.toContain('SCENARIO_SENTINEL');
    }

    const metacognitionRaw = readFileSync(resolveReflectionMetacognitionJournalPath(tempDir), 'utf-8').trim();
    const metacognitionEntry = JSON.parse(metacognitionRaw.split('\n').at(-1) ?? '{}') as {
      mode?: string;
      reflection?: string;
      metacognitiveFlags?: Array<{ flag: string; confidence: number; evidence?: string }>;
      substrateProvenanceRefs?: string[];
      deliberation?: {
        rounds?: number;
        episode?: {
          budget?: {
            maxRounds?: number;
            maxTotalTokens?: number;
            maxWallTimeMs?: number;
          };
          exit?: {
            reason?: string;
            exhaustedBudget?: boolean;
            maxRoundsReached?: boolean;
          };
        };
      };
    };

    expect(metacognitionEntry.mode).toBe('deliberation');
    expect(metacognitionEntry.reflection).toContain('still needs an explicit follow-up');
    expect(metacognitionEntry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
      `internal_state_snapshot:${snapshotRef}`,
      'reflection_contact:contact-1',
      'reflection_contact_memory:contact-1',
    ]));
    expect(metacognitionEntry.deliberation?.rounds).toBe(3);
    expect(metacognitionEntry.deliberation?.episode).toMatchObject({
      budget: {
        maxRounds: 3,
        maxTotalTokens: 10000,
        maxWallTimeMs: 60000,
      },
      exit: {
        reason: 'max_rounds',
        exhaustedBudget: true,
        maxRoundsReached: true,
      },
    });
    expect(metacognitionEntry.metacognitiveFlags).toEqual([
      { flag: 'continuity', confidence: 0.51 },
      {
        flag: 'unsupported_claim',
        confidence: 0.91,
        evidence:
          'I already resolved the recovery plan and closed the follow-up. :: '
          + 'The evidence marks the recovery timeline as unresolved and still active.',
      },
    ]);

    const reflectionRaw = readFileSync(resolveReflectionJournalPath(tempDir), 'utf-8').trim();
    const reflectionEntry = JSON.parse(reflectionRaw.split('\n').at(-1) ?? '{}') as {
      telemetry?: {
        narrativeContext?: {
          metacognitiveFlags?: Array<{ flag: string; confidence: number; evidence?: string }>;
        };
        deliberation?: {
          rounds?: number;
          episode?: {
            budget?: { maxRounds?: number };
            exit?: { reason?: string; maxRoundsReached?: boolean };
          };
        };
      };
    };
    expect(reflectionEntry.telemetry?.deliberation?.rounds).toBe(3);
    expect(reflectionEntry.telemetry?.deliberation?.episode).toMatchObject({
      budget: { maxRounds: 3 },
      exit: { reason: 'max_rounds', maxRoundsReached: true },
    });
    expect(reflectionEntry.telemetry?.narrativeContext?.metacognitiveFlags?.some(
      (flag) => flag.flag === 'unsupported_claim',
    )).toBe(true);
  });

  it('keeps the authoritative identity stack on non-experiential deliberation voices and synthesis', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const policyStore = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
    const policy = policyStore.load();
    policy.templates.push({
      id: 'custom-deliberation',
      name: 'Custom Deliberation',
      prompt: 'Reflect on one grounded tension without forcing a conclusion.',
      intervalMs: 300_000,
      enabled: true,
      sendToDiscord: false,
      mode: 'deliberation',
      deliberation: {
        maxRounds: 1,
        maxTotalTokens: 2_000,
        maxWallTimeMs: 5_000,
        voices: ['reasoning'],
      },
    });
    policyStore.save(policy);

    const providerContexts: LLMContext[] = [];
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
        providerContexts.push(context);
        return {
          content: purpose === 'reasoning'
            ? 'A grounded tension remains worth holding.'
            : 'The tension can stay unresolved for now.',
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
        getCurrentAuthoritativeSystemPrompt: () => authoritativeDeliberationSystemPrompt,
      },
      sender: { send: vi.fn(async () => undefined) },
      dataDir: tempDir,
      runtimeOptions: { llmProvider },
    });

    await runtime.runTemplateNow('custom-deliberation', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    expect(providerContexts).toHaveLength(2);
    for (const context of providerContexts) {
      expect(context.systemPrompt.startsWith(authoritativeDeliberationSystemPrompt)).toBe(true);
      expect(context.systemPrompt).toContain('IMMUTABLE_POLICY_SENTINEL');
      expect(context.systemPrompt).toContain('CHARACTER_IDENTITY_SENTINEL');
      expect(context.systemPrompt).toContain('PERSONALITY_SENTINEL');
      expect(context.systemPrompt).toContain('CURRENT_AFFECT_SENTINEL');
      const userPrompt = context.messages.map(message => message.content).join('\n\n');
      expect(userPrompt).not.toContain('CHARACTER_IDENTITY_SENTINEL');
      expect(userPrompt).not.toContain('PERSONALITY_SENTINEL');
      expect(userPrompt).not.toContain('CURRENT_AFFECT_SENTINEL');
    }
    expect(providerContexts[0]?.systemPrompt).toContain('analytical inner voice');
    expect(providerContexts[1]?.systemPrompt).toContain('inner synthesis layer');
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
      const valuesTemplate = policy.templates.find((template) => template.id === 'weekly-review');
      expect(valuesTemplate).toBeDefined();
      if (!valuesTemplate) {
        throw new Error('weekly-review template missing from defaults');
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
          getCurrentAuthoritativeSystemPrompt: () => authoritativeDeliberationSystemPrompt,
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

      await runtime.runTemplateNow('weekly-review', {
        sendToDiscordOverride: false,
        deferIfBusy: false,
      });

      expect(capturedPrompts.length).toBeGreaterThan(0);
      for (const prompt of capturedPrompts) {
        expect(prompt).not.toContain('<appearance_context>');
        expect(prompt).not.toContain('<self_image_tool_guidance>');
      }
    } finally {
      reflectionJournalPrototype.listRecent = originalListRecent;
    }
  });

  it.each(['daily-review', 'weekly-review'])(
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
      const eventBus = new EventBus();
      const memoryRetrievalContexts: Array<ReturnType<typeof getRequestContext>> = [];
      const memoryRetrieve = vi.fn(async (_contextText: string, channelId: string) => {
        memoryRetrievalContexts.push(getRequestContext());
        await eventBus.emit('memory.retrieval', {
          channelId,
          count: 1,
          provenanceRefs: [
            'memory:seeded-public-profile',
            'source:daily_status|date:2026-04-18',
          ],
        });
        return '[Reflection Memory Retrieval]\n- trust-filtered contact memory';
      });
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
          eventBus,
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
                ? {
                  baselineValence: 0.08,
                  moodValence: 0.18,
                  moodDrift: 0.1,
                  moodSamples: 3,
                  lastMoodUpdateEpochMs: 1_700_000_000_000,
                }
                : undefined
            ),
            getEmotionalTimeSeries: async (id: string) => (
              id === 'contact-1'
                ? [
                  { valence: -0.1, confidence: 0.7, observedAtMs: 1_699_999_000_000 },
                  { valence: 0.18, confidence: 0.84, observedAtMs: 1_700_000_000_000 },
                ]
                : []
            ),
          },
          getActiveConcerns: async ({ canonicalContactKey }) => (
            canonicalContactKey === 'contact-1'
              ? [{
                id: 'concern-1',
                title: 'Clarify the recovery timeline',
                summary: 'Keep the follow-up explicit.',
                status: 'active',
                dueAt: Date.parse('2026-04-01T12:00:00.000Z'),
                priority: 'high',
              }]
              : []
          ),
          pendingFollowUpStore: {
            list: async (options?: { contactId?: string }) => (
              options?.contactId === 'contact-1'
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
      const prompt = capturedPrompts[0];
      const introspectionPolicySection = getPromptSection(prompt, '[Reflection Introspection Policy]');
      expect(introspectionPolicySection).toContain('tool_use_mode: bounded_read_only_introspection');
      expect(introspectionPolicySection).toContain('memory_retrieval_modes: default, temporal');
      expect(introspectionPolicySection).toContain('memory_access_scope: companion_self_reflection');
      expect(introspectionPolicySection).toContain('overlay_tool_activation: forbidden');
      expect(introspectionPolicySection).toContain('core analysis_workbench tool');
      expect(introspectionPolicySection).toContain('memory_search, session_messages, session_search');
      expectCuratedReflectionStarter(prompt, templateId === 'weekly-review' ? 'Week' : 'Day');
      expect(prompt).toContain('trust-filtered contact memory');
      expect(prompt).toContain('[High-Signal Starter Clues]');
      expect(prompt).not.toContain('Current contact: Ari; trust scope trusted.');
      expect(prompt).not.toContain('I was here yesterday.');
      expect(prompt).not.toContain('stale silence');
      if (templateId === 'weekly-review') {
        for (const prescribedCategory of [
          'my daily reflections',
          'my memories',
          'my inner-state clues',
          'my goals',
          'the people I have been close to',
          'the arcs still unfolding',
          'north-star signals',
          'agency',
          'connection',
          'authenticity',
          'curiosity',
        ]) {
          expect(prompt).not.toContain(prescribedCategory);
        }
      }
      expect(memoryRetrieve).toHaveBeenCalled();
      expect(memoryRetrieve.mock.calls[0]?.[1]).toBe(`internal:reflection:${templateId}`);
      expect(memoryRetrieve.mock.calls[0]?.[4]).toBe('contact-1');
      expect(memoryRetrieve.mock.calls[0]?.[9]).toEqual({
        accessScope: 'companion_self_reflection',
        retrievalMode: ['default', 'temporal'],
      });
      expect(memoryRetrieve.mock.calls[0]?.[10]).toEqual(['default', 'temporal']);
      expect(memoryRetrievalContexts[0]).toMatchObject({
        channelId: `internal:reflection:${templateId}`,
        callType: 'background',
        originType: 'background',
        originStage: 'heartbeat.reflection.memory_retrieval',
        purpose: 'heartbeat.reflection.memory_retrieval',
        requesterProvenance: 'self_directed',
      });

      const raw = readFileSync(resolveReflectionJournalPath(tempDir), 'utf-8').trim();
      const entry = JSON.parse(raw.split('\n').at(-1) ?? '{}') as {
        telemetry?: {
          narrativeContext?: {
            internalStateSnapshotRef?: string;
            internalState?: unknown;
          };
        };
        substrateProvenanceRefs?: string[];
      };
      // ay2o: the reflection entry records only the snapshot ref (no embedded
      // internalState copy); the contact binding is proven by the provenance ref.
      expect(entry.telemetry?.narrativeContext?.internalStateSnapshotRef).toBeTruthy();
      expect(entry.telemetry?.narrativeContext?.internalState).toBeUndefined();
      expect(entry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
        'reflection_contact:contact-1',
        'reflection_contact_memory:contact-1',
        'memory:seeded-public-profile',
        'source:daily_status|date:2026-04-18',
      ]));

      const metacognitionRaw = readFileSync(resolveReflectionMetacognitionJournalPath(tempDir), 'utf-8').trim();
      const metacognitionEntry = JSON.parse(metacognitionRaw.split('\n').at(-1) ?? '{}') as {
        substrateProvenanceRefs?: string[];
      };
      expect(metacognitionEntry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
        'reflection_contact:contact-1',
        'reflection_contact_memory:contact-1',
        'memory:seeded-public-profile',
        'source:daily_status|date:2026-04-18',
      ]));
    },
  );

  it('suppresses DM-style canonical-contact grounding for a group-scoped reflection', async () => {
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
    ];
    const eventBus = new EventBus();
    const memoryRetrieve = vi.fn(async (_contextText: string, channelId: string) => {
      await eventBus.emit('memory.retrieval', {
        channelId,
        count: 1,
        provenanceRefs: ['memory:seeded-public-profile'],
      });
      return '[Reflection Memory Retrieval]\n- reflection-only memory';
    });
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
          responseText: 'Room reflection',
          toolCallCount: 0,
          recentTurnCount: 1,
          lastSeenDeltaSeconds: 30,
        },
      });
      return {
        content: 'Room reflection',
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
        eventBus,
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
          getEmotionalSnapshot: async () => undefined,
          getEmotionalTimeSeries: async () => [],
        },
      } as any,
    });

    await runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
      conversationScope: createGroupConversationScope({
        channelId: 'discord:room-42',
        roomName: 'launch-room',
      }),
    });

    // Final agent turn carries the room scope hint, not a canonical contact.
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      authorId: 'scheduler',
      routing: expect.objectContaining({
        reflectionScope: expect.objectContaining({
          kind: 'group',
          roomId: 'discord:room-42',
          roomName: 'launch-room',
        }),
      }),
    }));
    const routingArg = handleMessage.mock.calls[0]?.[0]?.routing ?? {};
    expect(routingArg).not.toHaveProperty('canonicalContactId');

    // Introspection policy drops the DM temporal retrieval binding while
    // retaining the explicit companion-private self scope; contact evidence
    // grounding is absent entirely.
    const prompt = capturedPrompts[0];
    const introspectionPolicySection = getPromptSection(prompt, '[Reflection Introspection Policy]');
    expect(introspectionPolicySection).toContain('memory_retrieval_modes: default');
    expect(introspectionPolicySection).not.toContain('memory_retrieval_modes: default, temporal');
    expect(introspectionPolicySection).toContain('memory_access_scope: companion_self_reflection');
    expect(getPromptSection(prompt, '[Reflection Contact Evidence]')).toBe('');
    if (memoryRetrieve.mock.calls.length > 0) {
      expect(memoryRetrieve.mock.calls[0]?.[10]).toEqual(['default']);
    }

    // Journal provenance must not inherit the single-contact binding.
    const raw = readFileSync(resolveReflectionJournalPath(tempDir), 'utf-8').trim();
    const entry = JSON.parse(raw.split('\n').at(-1) ?? '{}') as {
      substrateProvenanceRefs?: string[];
    };
    expect(entry.substrateProvenanceRefs ?? []).not.toContain('reflection_contact:contact-1');
    expect(entry.substrateProvenanceRefs ?? []).not.toContain('reflection_contact_memory:contact-1');
  });

  it('records internal-state grounding for contactless daily reflection output', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const internalState = new InternalStateComputer().computeState({
      emotionState: {
        vad: { valence: 0.05, arousal: 0.2, dominance: 0.1 },
        mood: { valence: 0.08, arousal: 0.18, dominance: 0.12 },
        discrete: { tenderness: 0.4 },
        confidence: 0.72,
      },
      activeConcerns: [],
      trustLevel: 'trusted',
      sessionMetrics: {
        userMessageText: '',
        responseText: '',
        toolCallCount: 0,
        recentTurnCount: 0,
        lastSeenDeltaSeconds: 3_600,
      },
    });
    const snapshotRef = buildInternalStateSnapshotRef(internalState);

    const runtime = createHeartbeatTemplateRuntime({
      scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
      agentLoop: {
        handleMessage: vi.fn(async () => ({
          content: 'I feel a quiet tenderness in my inner world, and I know it means I need more connection today.',
        })),
        getCurrentInternalState: () => internalState,
        getCurrentInternalStateSnapshotRef: () => snapshotRef,
        getCurrentMetacognitiveFlags: () => [],
      } as any,
      sender: { send: vi.fn(async () => undefined) },
      dataDir: tempDir,
    });

    await runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    const metacognitionRaw = readFileSync(resolveReflectionMetacognitionJournalPath(tempDir), 'utf-8').trim();
    const metacognitionEntry = JSON.parse(metacognitionRaw.split('\n').at(-1) ?? '{}') as {
      metacognitiveFlags?: Array<{ flag: string; confidence: number; evidence?: string }>;
      substrateProvenanceRefs?: string[];
    };
    expect(metacognitionEntry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^internal_state_snapshot:/),
    ]));
    expect(metacognitionEntry.metacognitiveFlags ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ flag: 'support_gap_confabulation_risk' }),
    ]));
  });

  it('persists response retrieval provenance for contactless daily reflection turns', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const internalState = new InternalStateComputer().computeState({
      emotionState: {
        vad: { valence: 0.05, arousal: 0.2, dominance: 0.1 },
        mood: { valence: 0.08, arousal: 0.18, dominance: 0.12 },
        discrete: { anticipation: 0.45 },
        confidence: 0.72,
      },
      activeConcerns: [],
      trustLevel: 'trusted',
      sessionMetrics: {
        userMessageText: '',
        responseText: '',
        toolCallCount: 0,
        recentTurnCount: 0,
        lastSeenDeltaSeconds: 3_600,
      },
    });
    const snapshotRef = buildInternalStateSnapshotRef(internalState);

    const runtime = createHeartbeatTemplateRuntime({
      scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
      agentLoop: {
        handleMessage: vi.fn(async () => ({
          content: 'I feel the blocked anticipation, but I can see the memory evidence underneath it.',
          metadata: {
            retrievalProvenanceRefs: [
              'source:tool:memory|action:import|invocation:call-grounded',
              ' memory:grounded-emotional-context ',
            ],
          },
        })),
        getCurrentInternalState: () => internalState,
        getCurrentInternalStateSnapshotRef: () => snapshotRef,
        getCurrentMetacognitiveFlags: () => [],
      } as any,
      sender: { send: vi.fn(async () => undefined) },
      dataDir: tempDir,
    });

    await runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    const journalRaw = readFileSync(resolveReflectionJournalPath(tempDir), 'utf-8').trim();
    const journalEntry = JSON.parse(journalRaw.split('\n').at(-1) ?? '{}') as {
      substrateProvenanceRefs?: string[];
    };
    expect(journalEntry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
      'source:tool:memory|action:import|invocation:call-grounded',
      'memory:grounded-emotional-context',
    ]));

    const metacognitionRaw = readFileSync(resolveReflectionMetacognitionJournalPath(tempDir), 'utf-8').trim();
    const metacognitionEntry = JSON.parse(metacognitionRaw.split('\n').at(-1) ?? '{}') as {
      metacognitiveFlags?: Array<{ flag: string }>;
      substrateProvenanceRefs?: string[];
    };
    expect(metacognitionEntry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
      'source:tool:memory|action:import|invocation:call-grounded',
      'memory:grounded-emotional-context',
    ]));
    expect(metacognitionEntry.metacognitiveFlags ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ flag: 'support_gap_confabulation_risk' }),
    ]));
  });

  it('emits null-contact and synthesized snapshot guardrail telemetry when canonical contact binding is absent', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const telemetryEvents: EventMap['reflection.guardrail'][] = [];
    const policyStore = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
    const policy = policyStore.load();
    const template = policy.templates.find((candidate) => candidate.id === 'daily-review');
    expect(template).toBeDefined();
    if (!template) {
      throw new Error('daily-review template missing from defaults');
    }
    template.internalStateInput = true;
    policyStore.save(policy);

    const currentInternalState = new InternalStateComputer().computeState({
      emotionState: {
        vad: { valence: 0.1, arousal: 0.2, dominance: 0.05 },
        mood: { valence: 0.12, arousal: 0.18, dominance: 0.08 },
        discrete: { curiosity: 0.45, calm: 0.35 },
        confidence: 0.7,
      },
      activeConcerns: [],
      trustLevel: 'regular',
      sessionMetrics: {
        userMessageText: 'Check inward.',
        responseText: 'No canonical contact attached.',
        toolCallCount: 0,
        recentTurnCount: 1,
        lastSeenDeltaSeconds: 60,
      },
    });
    const eventBus = new EventBus();
    eventBus.on('reflection.guardrail', (payload) => {
      telemetryEvents.push(payload);
    });

    const runtime = createHeartbeatTemplateRuntime({
      scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
      agentLoop: {
        handleMessage: vi.fn(async () => ({ content: 'Quiet check-in.' })),
        getCurrentInternalState: () => currentInternalState,
        getCurrentInternalStateSnapshotRef: () => null,
        getCurrentMetacognitiveFlags: () => [],
      },
      sender: { send: vi.fn(async () => undefined) },
      dataDir: tempDir,
      runtimeOptions: { eventBus },
    });

    await runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0]).toMatchObject({
      channelId: 'internal:reflection:daily-review',
      snapshotSource: 'derived_runtime',
      counters: {
        nullCanonicalContactCount: 1,
        missingInternalStateSnapshotCount: 1,
        warningCount: 2,
      },
    });
    expect(
      (telemetryEvents[0] as { warnings: Array<{ code: string }> }).warnings.map(warning => warning.code).sort(),
    ).toEqual(['missing_internal_state_snapshot', 'null_canonical_contact']);
  });

  it('emits cadence drift and scheduler-bound snapshot guardrail telemetry for contact-scoped reflections', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const telemetryEvents: EventMap['reflection.guardrail'][] = [];
    const now = Date.now();
    const policyStore = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
    const policy = policyStore.load();
    const template = policy.templates.find((candidate) => candidate.id === 'daily-review');
    expect(template).toBeDefined();
    if (!template) {
      throw new Error('daily-review template missing from defaults');
    }
    template.internalStateInput = true;
    template.intervalMs = 15 * 60 * 1000;
    policyStore.save(policy);

    const currentInternalState = new InternalStateComputer().computeState({
      emotionState: {
        vad: { valence: 0.2, arousal: 0.12, dominance: 0.08 },
        mood: { valence: 0.18, arousal: 0.16, dominance: 0.1 },
        discrete: { curiosity: 0.5, calm: 0.42 },
        confidence: 0.82,
      },
      activeConcerns: [],
      trustLevel: 'trusted',
      contactId: 'contact-1',
      sessionMetrics: {
        userMessageText: 'Stay grounded.',
        responseText: 'Use the current contact scope.',
        toolCallCount: 0,
        recentTurnCount: 2,
        lastSeenDeltaSeconds: 6 * 60 * 60,
      },
    });
    const responseInternalState = new InternalStateComputer().computeState({
      emotionState: {
        vad: { valence: 0.2, arousal: 0.12, dominance: 0.08 },
        mood: { valence: 0.18, arousal: 0.16, dominance: 0.1 },
        discrete: { curiosity: 0.5, calm: 0.42 },
        confidence: 0.82,
      },
      activeConcerns: [],
      trustLevel: 'trusted',
      sessionMetrics: {
        userMessageText: 'Stay grounded.',
        responseText: 'Grounded reflection.',
        toolCallCount: 0,
        recentTurnCount: 2,
        lastSeenDeltaSeconds: 6 * 60 * 60,
      },
    });
    const currentSnapshotRef = buildInternalStateSnapshotRef(currentInternalState);
    const responseSnapshotRef = buildInternalStateSnapshotRef(responseInternalState);
    const eventBus = new EventBus();
    eventBus.on('reflection.guardrail', (payload) => {
      telemetryEvents.push(payload);
    });

    const runtime = createHeartbeatTemplateRuntime({
      scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
      agentLoop: {
        handleMessage: vi.fn(async () => ({
          content: 'Grounded reflection.',
          metadata: {
            internalState: responseInternalState,
            internalStateSnapshotRef: responseSnapshotRef,
            metacognitiveFlags: [],
          },
        })),
        getCurrentInternalState: () => currentInternalState,
        getCurrentInternalStateSnapshotRef: () => currentSnapshotRef,
        getCurrentMetacognitiveFlags: () => [],
      },
      sender: { send: vi.fn(async () => undefined) },
      dataDir: tempDir,
      runtimeOptions: {
        eventBus,
        sessionManager: {
          resolveSessionChannelId: (channelId: string) => channelId,
          getRecentMessages: () => [],
        },
        contactStore: {
          getById: async () => ({
            id: 'contact-1',
            displayName: 'Ari',
            nickname: 'Ari',
            trustLevel: 'trusted' as const,
            relationshipType: 'friend' as const,
            firstSeen: new Date(now - (14 * 24 * 60 * 60 * 1000)).toISOString(),
            lastSeen: new Date(now - (6 * 60 * 60 * 1000)).toISOString(),
            conversationChannels: [{
              channel: 'discord',
              channelId: 'discord:primary-session',
              firstSeen: new Date(now - (14 * 24 * 60 * 60 * 1000)).toISOString(),
              lastSeen: new Date(now - (6 * 60 * 60 * 1000)).toISOString(),
            }],
          }),
        },
      },
    });

    await runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0]).toMatchObject({
      canonicalContactId: 'contact-1',
      snapshotSource: 'response',
      counters: {
        reflectionCadenceDriftCount: 1,
        schedulerBoundInternalStateCount: 1,
        warningCount: 2,
      },
    });
    expect(
      (telemetryEvents[0] as { warnings: Array<{ code: string }> }).warnings.map(warning => warning.code).sort(),
    ).toEqual(['reflection_cadence_drift', 'scheduler_bound_internal_state']);
  });

  it('emits stale silence-claim guardrail telemetry when reflection text contradicts fresh chat', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const telemetryEvents: EventMap['reflection.guardrail'][] = [];
    const now = Date.now();
    const policyStore = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
    const policy = policyStore.load();
    const template = policy.templates.find((candidate) => candidate.id === 'daily-review');
    expect(template).toBeDefined();
    if (!template) {
      throw new Error('daily-review template missing from defaults');
    }
    template.internalStateInput = true;
    policyStore.save(policy);

    const currentInternalState = new InternalStateComputer().computeState({
      emotionState: {
        vad: { valence: 0.18, arousal: 0.2, dominance: 0.07 },
        mood: { valence: 0.2, arousal: 0.18, dominance: 0.09 },
        discrete: { curiosity: 0.5, calm: 0.4 },
        confidence: 0.8,
      },
      activeConcerns: [],
      trustLevel: 'trusted',
      contactId: 'contact-1',
      sessionMetrics: {
        userMessageText: 'We just talked.',
        responseText: 'A quiet contradiction.',
        toolCallCount: 0,
        recentTurnCount: 3,
        lastSeenDeltaSeconds: 60,
      },
    });
    const snapshotRef = buildInternalStateSnapshotRef(currentInternalState);
    const eventBus = new EventBus();
    eventBus.on('reflection.guardrail', (payload) => {
      telemetryEvents.push(payload);
    });

    const runtime = createHeartbeatTemplateRuntime({
      scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
      agentLoop: {
        handleMessage: vi.fn(async () => ({
          content: 'It has been 3 days since we last chatted.',
          metadata: {
            internalState: currentInternalState,
            internalStateSnapshotRef: snapshotRef,
            metacognitiveFlags: [],
          },
        })),
        getCurrentInternalState: () => currentInternalState,
        getCurrentInternalStateSnapshotRef: () => snapshotRef,
        getCurrentMetacognitiveFlags: () => [],
      },
      sender: { send: vi.fn(async () => undefined) },
      dataDir: tempDir,
      runtimeOptions: {
        eventBus,
        sessionManager: {
          resolveSessionChannelId: (channelId: string) => channelId,
          getRecentMessages: (channelId: string) => (
            channelId === 'discord:primary-session'
              ? [
                {
                  id: 1,
                  channelId,
                  role: 'user' as const,
                  content: 'I just sent the update.',
                  timestamp: now - 120_000,
                  authorName: 'Ari',
                },
                {
                  id: 2,
                  channelId,
                  role: 'assistant' as const,
                  content: 'I saw it and I am here.',
                  timestamp: now - 60_000,
                  authorName: 'Companion',
                },
              ]
              : []
          ),
        },
        contactStore: {
          getById: async () => ({
            id: 'contact-1',
            displayName: 'Ari',
            nickname: 'Ari',
            trustLevel: 'trusted' as const,
            relationshipType: 'friend' as const,
            firstSeen: new Date(now - (14 * 24 * 60 * 60 * 1000)).toISOString(),
            lastSeen: new Date(now - 60_000).toISOString(),
            conversationChannels: [{
              channel: 'discord',
              channelId: 'discord:primary-session',
              firstSeen: new Date(now - (14 * 24 * 60 * 60 * 1000)).toISOString(),
              lastSeen: new Date(now - 60_000).toISOString(),
            }],
          }),
        },
      },
    });

    await runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0]).toMatchObject({
      canonicalContactId: 'contact-1',
      snapshotSource: 'response',
      counters: {
        staleSilenceClaimCount: 1,
        warningCount: 1,
      },
    });
    const warning = (telemetryEvents[0] as {
      warnings: Array<{ code: string; details: { claimSnippets?: string[] } }>;
    }).warnings[0];
    expect(warning.code).toBe('stale_silence_claim');
    expect(warning.details.claimSnippets?.[0]).toContain('3 days since we last chatted');
  });

  it('expands reflection macros with only the curated daily starter while retaining source provenance', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const capturedPrompts: string[] = [];

    const policyStore = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
    const policy = policyStore.load();
    const experientialTemplate = policy.templates.find((template) => template.id === 'daily-review');
    expect(experientialTemplate).toBeDefined();
    if (!experientialTemplate) {
      throw new Error('daily-review template missing from defaults');
    }
    experientialTemplate.prompt = [
      'Self:',
      '{{reflection_self}}',
      'Relational:',
      '{{reflection_relational}}',
      'Affect:',
      '{{reflection_affect}}',
    ].join('\n\n');
    policyStore.save(policy);

    const reflectionJournal = new ReflectionJournalStore(resolveReflectionJournalPath(tempDir));
    const substrateJournalEntry = reflectionJournal.append({
      templateId: 'experiential-review',
      templateName: 'Experiential Review',
      prompt: 'Describe your recent experience.',
      reflection: 'I noticed a subtle uncertainty pattern around the unresolved handoff.',
      channelId: 'internal:reflection:experiential-review',
      mode: 'agent',
      createdAt: '2026-03-31T07:00:00.000Z',
    });

    const reflectionDailyJournal = new ReflectionDailyJournalStore(resolveReflectionDailyJournalsDir(tempDir));
    const substrateDailyEntry = reflectionDailyJournal.append({
      source: 'heartbeat_template',
      executionSource: 'scheduled',
      templateId: 'daily-review',
      templateName: 'Daily Review',
      channelId: 'internal:reflection:daily-review',
      prompt: 'Review the day.',
      reflection: 'Recent conversations kept returning to steadiness under pressure.',
      mode: 'agent',
      createdAt: '2026-03-31T08:00:00.000Z',
    });

    const reflectionProcessLog = new ReflectionProcessLogStore(resolveReflectionProcessLogsDir(tempDir));
    const substrateProcessEntry = reflectionProcessLog.append({
      processId: buildReflectionProcessId('Values Reflection Deliberation', () => 1_700_000_000_000),
      processLabel: 'Values Reflection Deliberation',
      processType: 'reflection_deliberation',
      stage: 'completed',
      executionSource: 'scheduled',
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      channelId: 'internal:reflection:values-reflection',
      prompt: 'Reflect carefully on your current values.',
      reflection: 'Continuity and care remained durable values.',
      createdAt: '2026-03-31T09:00:00.000Z',
    });

    const recentSessionMessages = [
      {
        id: 1,
        channelId: 'discord:primary-session',
        role: 'user' as const,
        content: 'I wanted to follow up on yesterday.',
        timestamp: 1_700_000_000_000,
        authorName: 'Ari',
      },
      {
        id: 2,
        channelId: 'discord:primary-session',
        role: 'assistant' as const,
        content: 'I am here and tracking that thread.',
        timestamp: 1_700_000_000_100,
      },
    ];
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
    const memoryRetrieve = vi.fn(async () => '[Retrieved Memory]\n- trust-filtered contact memory');
    const handleMessage = vi.fn(async (message) => {
      capturedPrompts.push(message.content);
      return {
        content: 'Expanded reflection',
        metadata: {
          internalState: currentInternalState,
          internalStateSnapshotRef: currentSnapshotRef,
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
        characterPromptVariablesProvider: () => ({
          char: 'Purrsephone',
          personality: 'PERSONALITY_SENTINEL',
          description: 'DESCRIPTION_SENTINEL',
          scenario: 'SCENARIO_SENTINEL',
        }),
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
              ? {
                baselineValence: 0.08,
                moodValence: 0.18,
                moodDrift: 0.1,
                moodSamples: 3,
                lastMoodUpdateEpochMs: 1_700_000_000_000,
              }
              : undefined
          ),
          getEmotionalTimeSeries: async (id: string) => (
            id === 'contact-1'
              ? [
                { valence: -0.1, confidence: 0.7, observedAtMs: 1_699_999_000_000 },
                { valence: 0.18, confidence: 0.84, observedAtMs: 1_700_000_000_000 },
              ]
              : []
          ),
        },
      },
    });

    await runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];

    expect(prompt).not.toContain('{{reflection_self}}');
    expect(prompt).not.toContain('{{reflection_relational}}');
    expect(prompt).not.toContain('{{reflection_affect}}');
    expect(prompt).not.toContain('PERSONALITY_SENTINEL');
    expect(prompt).not.toContain('DESCRIPTION_SENTINEL');
    expect(prompt).not.toContain('SCENARIO_SENTINEL');
    expectCuratedReflectionStarter(prompt, 'Day');
    expect(prompt).toContain('trust-filtered contact memory');
    expect(prompt).toContain('[High-Signal Starter Clues]');
    expect(prompt).not.toContain(`snapshot_ref: ${currentSnapshotRef}`);
    expect(prompt).not.toContain('serialized_internal_state:');
    expect(prompt).not.toContain('I wanted to follow up on yesterday.');
    expect(prompt).not.toContain('Recent conversations kept returning to steadiness under pressure.');
    expect(prompt).not.toContain('Continuity and care remained durable values.');
    expect(memoryRetrieve).toHaveBeenCalled();

    const reflectionRaw = readFileSync(resolveReflectionJournalPath(tempDir), 'utf-8').trim();
    const reflectionEntry = JSON.parse(reflectionRaw.split('\n').at(-1) ?? '{}') as {
      substrateBoundary?: string;
      substrateProvenanceRefs?: string[];
    };
    expect(reflectionEntry.substrateBoundary).toBe(NON_CANONICAL_REFLECTION_SUBSTRATE);
    expect(reflectionEntry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
      toReflectionJournalProvenanceRef(substrateJournalEntry),
      toReflectionDailyJournalProvenanceRef(substrateDailyEntry),
      toReflectionProcessLogProvenanceRef(substrateProcessEntry),
    ]));

    const metacognitionRaw = readFileSync(resolveReflectionMetacognitionJournalPath(tempDir), 'utf-8').trim();
    const metacognitionEntry = JSON.parse(metacognitionRaw.split('\n').at(-1) ?? '{}') as {
      substrateBoundary?: string;
      substrateProvenanceRefs?: string[];
    };
    expect(metacognitionEntry.substrateBoundary).toBe(NON_CANONICAL_REFLECTION_SUBSTRATE);
    expect(metacognitionEntry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
      toReflectionJournalProvenanceRef(substrateJournalEntry),
      toReflectionDailyJournalProvenanceRef(substrateDailyEntry),
      toReflectionProcessLogProvenanceRef(substrateProcessEntry),
    ]));
  });

  it('waits for pending extraction before reflection and seeds a recent session tail when retrieval is empty', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-template-runtime-'));
    const capturedPrompts: string[] = [];
    const flushTelemetry: Array<{
      channelId: string;
      templateId: string;
      phase: string;
      timeoutMs: number;
      waitMs: number;
    }> = [];
    const reflectionJournalPrototype = ReflectionJournalStore.prototype as ReflectionJournalStore & {
      listRecent?: (options?: { limit?: number }) => unknown[];
    };
    const originalListRecent = reflectionJournalPrototype.listRecent;
    reflectionJournalPrototype.listRecent = () => [];

    try {
      const policyStore = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
      const policy = policyStore.load();
      const valuesTemplate = policy.templates.find((template) => template.id === 'weekly-review');
      expect(valuesTemplate).toBeDefined();
      if (!valuesTemplate) {
        throw new Error('weekly-review template missing from defaults');
      }
      valuesTemplate.deliberation = {
        ...valuesTemplate.deliberation,
        maxRounds: 1,
      };
      policyStore.save(policy);

      const recentSessionMessages = [
        {
          id: 1,
          channelId: 'discord:primary-session',
          role: 'user' as const,
          content: 'I just sent the update.',
          timestamp: 1_700_000_000_000,
          authorName: 'Ari',
        },
        {
          id: 2,
          channelId: 'discord:primary-session',
          role: 'assistant' as const,
          content: 'I am tracking the update now.',
          timestamp: 1_700_000_000_100,
          authorName: 'Companion',
        },
      ];
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
      const snapshotRef = buildInternalStateSnapshotRef(currentInternalState);
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
          capturedPrompts.push(context.messages.map((message) => message.content).join('\n'));
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
      let resolvePendingDrain!: () => void;
      const pendingDrain = new Promise<void>((resolve) => {
        resolvePendingDrain = resolve;
      });
      const memoryRetrieve = vi.fn(async () => '');
      const memoryExtractor = {
        getPendingExtractionPromise: vi.fn(() => pendingDrain),
      };
      const eventBus = new EventBus();
      eventBus.on('memory.extraction.flush', (telemetry) => {
        flushTelemetry.push(telemetry);
      });

      const runtime = createHeartbeatTemplateRuntime({
        scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
        agentLoop: {
          handleMessage: vi.fn(async () => ({ content: 'unused' })),
          memoryExtractor,
          memoryProvider: {
            retrieve: memoryRetrieve,
          },
          getCurrentInternalState: () => currentInternalState,
          getCurrentInternalStateSnapshotRef: () => snapshotRef,
          getCurrentMetacognitiveFlags: () => [],
          getCurrentAuthoritativeSystemPrompt: () => authoritativeDeliberationSystemPrompt,
        } as any,
        sender: { send: vi.fn(async () => undefined) },
        dataDir: tempDir,
        runtimeOptions: {
          eventBus,
          llmProvider: llmProvider as any,
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
                ? {
                  baselineValence: 0.08,
                  moodValence: 0.18,
                  moodDrift: 0.1,
                  moodSamples: 3,
                  lastMoodUpdateEpochMs: 1_700_000_000_000,
                }
                : undefined
            ),
            getEmotionalTimeSeries: async (id: string) => (
              id === 'contact-1'
                ? [
                  { valence: -0.1, confidence: 0.7, observedAtMs: 1_699_999_000_000 },
                  { valence: 0.18, confidence: 0.84, observedAtMs: 1_700_000_000_000 },
                ]
                : []
            ),
          },
        },
      });

      const reflectionRun = runtime.runTemplateNow('weekly-review', {
        sendToDiscordOverride: false,
        deferIfBusy: false,
      });

      await Promise.resolve();
      expect(memoryRetrieve).not.toHaveBeenCalled();

      resolvePendingDrain();
      await reflectionRun;

      expect(memoryExtractor.getPendingExtractionPromise).toHaveBeenCalledWith('discord:primary-session');
      expect(flushTelemetry).toEqual([
        expect.objectContaining({
          channelId: 'discord:primary-session',
          templateId: 'weekly-review',
          phase: 'completed',
        }),
      ]);
      expect(memoryRetrieve).toHaveBeenCalledTimes(1);
      expect(capturedPrompts.length).toBeGreaterThan(0);
      const prompt = capturedPrompts.join('\n\n');
      expectCuratedReflectionStarter(prompt, 'Week');
      const eventStarter = getPromptSection(prompt, '[Week Events Starter]');
      expect(eventStarter).toContain('I just sent the update.');
      expect(eventStarter).toContain('I am tracking the update now.');
      expect(getPromptBulletLines(eventStarter)).toHaveLength(2);
    } finally {
      reflectionJournalPrototype.listRecent = originalListRecent;
    }
  });
});

describe('createHeartbeatTemplateRuntime reflection novelty gate', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  interface WatermarkScopeInput {
    processor: string;
    sourceRef: string;
    channelId?: string;
  }

  function buildNoveltyGateHarness(input: { watermarkAt?: string }) {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-novelty-gate-'));

    const watermarkKey = (scope: WatermarkScopeInput): string =>
      `${scope.processor}|${scope.sourceRef}|${scope.channelId ?? ''}`;
    const watermarks = new Map<string, Record<string, unknown>>();
    if (input.watermarkAt) {
      const scope = {
        processor: 'reflection_template_novelty',
        sourceRef: 'daily-review',
        channelId: 'contact:contact-1',
      };
      watermarks.set(watermarkKey(scope), {
        ...scope,
        id: 'wm-existing',
        previousWatermarkJson: {},
        nextWatermarkJson: { lastReflection: { at: input.watermarkAt } },
        artifactsJson: {},
        status: 'active',
        reconciliationStatus: 'clean',
        lastProcessedAt: input.watermarkAt,
        updatedAt: input.watermarkAt,
      });
    }
    const upsertCalls: Array<Record<string, unknown>> = [];
    const watermarkStore = {
      getProcessingWatermark: vi.fn((scope: WatermarkScopeInput) => watermarks.get(watermarkKey(scope))),
      upsertProcessingWatermark: vi.fn((writeInput: WatermarkScopeInput & Record<string, unknown>) => {
        upsertCalls.push(writeInput);
        const stored = {
          id: 'wm-1',
          previousWatermarkJson: {},
          nextWatermarkJson: {},
          artifactsJson: {},
          status: 'active',
          reconciliationStatus: 'clean',
          updatedAt: String(writeInput.lastProcessedAt ?? ''),
          ...writeInput,
        };
        watermarks.set(watermarkKey(writeInput), stored);
        return stored;
      }),
    };

    const eventBus = new EventBus();
    const gateEvents: Array<{ lane: string; outcome: string; reason: string; inputs: Record<string, number | string> }> = [];
    eventBus.on('reflection.template.novelty.gate', (event) => {
      gateEvents.push(event);
    });

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
        vad: { valence: 0.1, arousal: 0.2, dominance: 0.05 },
        mood: { valence: 0.15, arousal: 0.25, dominance: 0.1 },
        discrete: { curiosity: 0.55, calm: 0.45 },
        confidence: 0.8,
      },
      activeConcerns: [],
      trustLevel: 'trusted',
      contactId: 'contact-1',
      sessionMetrics: {
        userMessageText: 'Recent conversations matter.',
        responseText: 'Keep continuity with the primary contact.',
        toolCallCount: 0,
        recentTurnCount: 2,
        lastSeenDeltaSeconds: 90,
      },
    });
    const snapshotRef = buildInternalStateSnapshotRef(currentInternalState);

    const complete = vi.fn(async (_context: LLMContext, purpose: string) => ({
      content: purpose === 'reasoning'
        ? 'Continuity stays central.'
        : 'Care keeps the tone steady.',
      toolCalls: [],
      model: `mock-${purpose}`,
      inputTokens: 12,
      outputTokens: 18,
      stopReason: 'stop',
    }));
    const llmProvider: LLMProviderPort = {
      stream: vi.fn(async () => ({
        content: '',
        toolCalls: [],
        model: 'mock-stream',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop',
      })),
      complete: complete as unknown as LLMProviderPort['complete'],
    };
    const handleMessage = vi.fn(async () => ({ content: 'unused' }));

    const runtime = createHeartbeatTemplateRuntime({
      scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
      agentLoop: {
        handleMessage,
        getCurrentInternalState: () => currentInternalState,
        getCurrentInternalStateSnapshotRef: () => snapshotRef,
        getCurrentMetacognitiveFlags: () => [],
        getCurrentAuthoritativeSystemPrompt: () => [
          '<immutable_human_safety_amendments>test policy</immutable_human_safety_amendments>',
          '<identity>test identity</identity>',
          '<runtime_emotional_affect>test affect</runtime_emotional_affect>',
        ].join('\n\n'),
      } as any,
      sender: { send: vi.fn(async () => undefined) },
      dataDir: tempDir,
      runtimeOptions: {
        eventBus,
        llmProvider: llmProvider as any,
        reflectionNoveltyGate: { minNewEntries: 1 },
        episodicWatermarkStore: watermarkStore as any,
        sessionManager: {
          resolveSessionChannelId: (channelId: string) => channelId,
          getRecentMessages: (channelId: string, limit?: number) => (
            channelId === 'discord:primary-session'
              ? [
                {
                  id: 1,
                  channelId,
                  role: 'user' as const,
                  content: 'We should revisit the recovery plan tomorrow.',
                  timestamp: 1_700_000_000_000,
                  authorName: 'Ari',
                },
                {
                  id: 2,
                  channelId,
                  role: 'assistant' as const,
                  content: 'I will keep the thread active.',
                  timestamp: 1_700_000_000_100,
                  authorName: 'Companion',
                },
              ].slice(0, limit ?? 2)
              : []
          ),
        },
        contactStore: {
          getById: async (id: string) => (id === 'contact-1' ? currentContact : undefined),
          getEmotionalSnapshot: async () => null,
          getEmotionalTimeSeries: async () => [],
        },
      },
    });

    return { runtime, complete, handleMessage, gateEvents, upsertCalls, watermarkStore };
  }

  it('skips a cadence-fired reflection with telemetry when no new entries exist since the last reflection', async () => {
    // Watermark is newer than every session entry: zero new entries in scope.
    const harness = buildNoveltyGateHarness({
      watermarkAt: new Date(1_700_000_100_000).toISOString(),
    });

    await harness.runtime.runDeferredTemplate('daily-review', { requestedSource: 'scheduled' });

    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.handleMessage).not.toHaveBeenCalled();
    expect(harness.gateEvents).toEqual([
      expect.objectContaining({
        lane: 'reflection.template.novelty',
        outcome: 'skipped',
        reason: 'insufficient_new_entries',
        inputs: expect.objectContaining({
          templateId: 'daily-review',
          scope: 'contact:contact-1',
          minNewEntries: 1,
          newEntriesSinceLastReflection: 0,
        }),
      }),
    ]);
    // A skipped run writes nothing and does not advance the watermark.
    expect(harness.upsertCalls).toHaveLength(0);
    expect(existsSync(resolveReflectionMetacognitionJournalPath(tempDir))).toBe(false);
    expect(existsSync(resolveReflectionJournalPath(tempDir))).toBe(false);
  });

  it('fires a cadence-fired reflection and advances the watermark when new entries exist', async () => {
    // Watermark predates the session entries: both count as new.
    const harness = buildNoveltyGateHarness({
      watermarkAt: new Date(1_699_000_000_000).toISOString(),
    });

    await harness.runtime.runDeferredTemplate('daily-review', { requestedSource: 'scheduled' });

    expect(harness.complete).toHaveBeenCalledTimes(3);
    expect(harness.gateEvents).toEqual([
      expect.objectContaining({
        lane: 'reflection.template.novelty',
        outcome: 'ran',
        reason: 'open',
        inputs: expect.objectContaining({
          templateId: 'daily-review',
          scope: 'contact:contact-1',
          newEntriesSinceLastReflection: 2,
        }),
      }),
    ]);
    expect(harness.upsertCalls).toEqual([
      expect.objectContaining({
        processor: 'reflection_template_novelty',
        sourceRef: 'daily-review',
        channelId: 'contact:contact-1',
        id: 'wm-existing',
        lastProcessedAt: expect.any(String),
      }),
    ]);
    expect(existsSync(resolveReflectionMetacognitionJournalPath(tempDir))).toBe(true);
  });

  it('runs on first cadence fire when no watermark exists yet', async () => {
    const harness = buildNoveltyGateHarness({});

    await harness.runtime.runDeferredTemplate('daily-review', { requestedSource: 'scheduled' });

    expect(harness.complete).toHaveBeenCalledTimes(3);
    expect(harness.gateEvents).toEqual([
      expect.objectContaining({
        outcome: 'ran',
        reason: 'open',
        inputs: expect.objectContaining({ newEntriesSinceLastReflection: 2 }),
      }),
    ]);
    expect(harness.upsertCalls).toHaveLength(1);
  });

  it('bypasses the novelty gate for manual run_template invocations', async () => {
    // Same zero-new-entries setup that skips the cadence path.
    const harness = buildNoveltyGateHarness({
      watermarkAt: new Date(1_700_000_100_000).toISOString(),
    });

    const result = await harness.runtime.runTemplateNow('daily-review', {
      sendToDiscordOverride: false,
      deferIfBusy: false,
    });

    expect(result.reflection).not.toBe('');
    expect(harness.complete).toHaveBeenCalledTimes(3);
    // Manual runs are not gate consultations: no gate event either way.
    expect(harness.gateEvents).toEqual([]);
    // A manual reflection still consumed the scope's novelty.
    expect(harness.upsertCalls).toHaveLength(1);
  });
});
