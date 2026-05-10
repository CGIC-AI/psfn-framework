import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import { InternalStateComputer, buildInternalStateSnapshotRef } from '../../../core/self-model/state.js';
import {
  resolveReflectionJournalPath,
  resolveReflectionMetacognitionJournalPath,
} from '../../../persistence/layout.js';
import { wireHeartbeatRuntime } from './parity.js';

describe('wireHeartbeatRuntime reflection metacognition journal', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records canonical reflection-run entries through the manual heartbeat tool path', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'parity-reflection-metacognition-'));
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
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
        userMessageText: 'How are things going?',
        responseText: 'Things feel steady.',
        toolCallCount: 0,
        recentTurnCount: 2,
        lastSeenDeltaSeconds: 90,
      },
    });
    const snapshotRef = buildInternalStateSnapshotRef(internalState);
    const metacognitiveFlags = [{ flag: 'steadiness', confidence: 0.68 }];
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({
        content: 'I stayed steady and attentive.',
        metadata: {
          internalState,
          internalStateSnapshotRef: snapshotRef,
          metacognitiveFlags,
          retrievalProvenanceRefs: [
            'source:tool:memory|action:import|invocation:call-parity-grounding',
          ],
        },
      }),
      getCurrentInternalState: vi.fn(() => internalState),
      getCurrentInternalStateSnapshotRef: vi.fn(() => snapshotRef),
      getCurrentMetacognitiveFlags: vi.fn(() => metacognitiveFlags),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    wireHeartbeatRuntime(target as any, scheduler, agentLoop as any, sender, tempDir);

    const runTool = target.registerTool.mock.calls
      .map(call => call[0])
      .find(tool => tool?.name === 'heartbeat_run_template') as {
        execute: (toolCallId: string, params: { templateId: string; sendToDiscord?: boolean }, signal: AbortSignal) => Promise<unknown>;
      };
    expect(runTool).toBeDefined();

    await runTool.execute(
      'call-reflection-meta',
      { templateId: 'musing', sendToDiscord: false },
      new AbortController().signal,
    );

    const raw = readFileSync(resolveReflectionMetacognitionJournalPath(tempDir), 'utf-8').trim();
    const entry = JSON.parse(raw.split('\n').at(-1) ?? '{}') as {
      kind: string;
      executionSource: string;
      initiatorSurface: string;
      initiatedBy: string;
      reason?: string;
      channelId: string;
      mode: string;
      internalStateSnapshotRef?: string;
      metacognitiveFlags?: Array<{ flag: string; confidence: number }>;
      reflectionJournalEntryId?: string;
      substrateProvenanceRefs?: string[];
    };

    expect(entry.kind).toBe('reflection_run');
    expect(entry.executionSource).toBe('manual');
    expect(entry.initiatorSurface).toBe('tool:heartbeat_run_template');
    expect(entry.initiatedBy).toBe('companion');
    expect(entry.reason).toBe('Manual reflection run via heartbeat_run_template');
    expect(entry.channelId).toBe('internal:reflection:musing');
    expect(entry.mode).toBe('agent');
    expect(entry.internalStateSnapshotRef).toBe(snapshotRef);
    expect(entry.metacognitiveFlags).toEqual(metacognitiveFlags);
    expect(entry.reflectionJournalEntryId).toBeDefined();
    expect(entry.substrateProvenanceRefs).toEqual([
      'source:tool:memory|action:import|invocation:call-parity-grounding',
    ]);

    const reflectionRaw = readFileSync(resolveReflectionJournalPath(tempDir), 'utf-8').trim();
    const reflectionEntry = JSON.parse(reflectionRaw.split('\n').at(-1) ?? '{}') as {
      substrateProvenanceRefs?: string[];
    };
    expect(reflectionEntry.substrateProvenanceRefs).toEqual([
      'source:tool:memory|action:import|invocation:call-parity-grounding',
    ]);
  });
});
