import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../agent/contracts.js';
import { EventBus } from '../../shared/event-bus.js';
import { ReflectionJournalStore } from '../../persistence/journals/reflection-journal.js';
import { InternalStateComputer, buildInternalStateSnapshotRef } from '../self-model/state.js';
import { resolveHeartbeatPolicyPath, resolveReflectionMetacognitionJournalPath } from '../../persistence/layout.js';
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
});
