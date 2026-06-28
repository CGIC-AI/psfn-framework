import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../../shared/event-bus.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import { HeartbeatPolicyStore } from '../../../core/scheduler/heartbeat-policy.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { readLastActiveSession } from '../../../system/lifecycle/notifications.js';
import { createDefaultExtendedToolAutoloadPolicy } from '../../../core/agent/extended-tool-autoload-policy.js';
import { buildInternalStateSnapshotRef, InternalStateComputer } from '../../../core/self-model/state.js';
import {
  wireFilesystemToolsRuntime,
  wireExtendedToolAutoloadPolicy,
  wireHeartbeatRuntime,
  wirePromptRuntime,
  wireSessionToolsRuntime,
  wireSettingsRuntime,
} from './parity.js';
import { wirePostTurnActionRuntime } from './post-turn-actions.js';
import { DEFERRED_TOOL_HANDOFF_ACTION_KIND } from '../../../core/agent/deferred-tool-handoff.js';
import {
  resolveHeartbeatPolicyPath,
  resolveReflectionJournalPath,
  resolveReflectionMetacognitionJournalPath,
  resolveValuesJournalPath,
} from '../../../persistence/layout.js';

function createInternalStateNarrativeFixture() {
  const internalState = new InternalStateComputer().computeState({
    emotionState: {
      vad: { valence: 0.2, arousal: 0.35, dominance: 0.1 },
      mood: { valence: 0.1, arousal: 0.25, dominance: 0.05 },
      discrete: { curiosity: 0.6, calm: 0.4 },
      confidence: 0.78,
    },
    activeConcerns: [{
      id: 'concern-1',
      text: 'Keep reflections grounded in lived experience',
      priority: 'high',
      source: 'heartbeat',
      createdAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2026-03-02T00:00:00.000Z',
    }],
    trustLevel: 'trusted',
    contactId: 'contact-1',
    sessionMetrics: {
      userMessageText: 'How am I doing right now?',
      responseText: 'You are steady with moments of uncertainty.',
      toolCallCount: 1,
      recentTurnCount: 4,
      lastSeenDeltaSeconds: 180,
    },
  });
  return {
    internalState,
    snapshotRef: buildInternalStateSnapshotRef(internalState),
    metacognitiveFlags: [
      { flag: 'uncertainty', confidence: 0.57, evidence: 'multiple competing hypotheses' },
    ],
  };
}

describe('wireSessionToolsRuntime', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-tools-runtime-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers the unified session surface without split list/search/grep aliases', async () => {
    const target = {
      registerTool: vi.fn(),
    };
    const sessionManager = {
      appendSystemNote: vi.fn(),
      listRecentSessions: vi.fn(() => []),
      searchTranscripts: vi.fn(() => []),
      getSessionActivity: vi.fn(() => null),
      setActiveContextSession: vi.fn(),
      getActiveContextSession: vi.fn(() => null),
      startFocusSession: vi.fn((channelId: string, scope: string) => ({
        focusId: 'focus-test',
        channelId,
        scope,
        startedAt: 1_700_000_000_000,
        startEntryId: 0,
      })),
      getFocusSessionContext: vi.fn(() => null),
      completeFocusSession: vi.fn(),
    } as any;
    const llmProvider = {
      stream: vi.fn(),
      complete: vi.fn(async () => ({
        content: 'focus summary',
        toolCalls: [],
        model: 'mock-context',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    } as any;

    wireSessionToolsRuntime(target, sessionManager, tempDir, llmProvider);

    const calls = target.registerTool.mock.calls as Array<[any, string]>;
    expect(calls).toHaveLength(1);
    expect(calls.map(([tool]) => tool.name)).toEqual(['session']);
    expect(calls.find(([tool]) => tool.name === 'session')?.[1]).toBe('core');

    const sessionTool = calls.find(([tool]) => tool.name === 'session')?.[0] as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: Record<string, unknown> }>;
    };
    expect(sessionTool).toBeDefined();

    const result = await sessionTool.execute('call-session-new', { action: 'new' });
    const details = result.details as {
      newSessionId: string;
      previousSessionId: string | null;
    };
    expect(details.previousSessionId).toBe(null);
    expect(details.newSessionId.startsWith('api:session-')).toBe(true);
    expect(sessionManager.setActiveContextSession).toHaveBeenCalledWith(details.newSessionId);
    expect(sessionManager.appendSystemNote).toHaveBeenCalledWith(
      details.newSessionId,
      'Session initialized via session action=new.',
    );

    const active = readLastActiveSession(tempDir);
    expect(active?.sessionId).toBe(details.newSessionId);
    expect(active?.channelType).toBe('api');
  });
});

describe('wireSettingsRuntime', () => {
  it('registers system as core and leaves promoted state on canonical toolset', () => {
    const target = {
      registerTool: vi.fn(),
      getPromotedExtendedToolsLimit: () => 4,
      getPromotedExtendedTools: () => ['repo_status'],
      addPromotedExtendedTool: vi.fn(() => ({
        ok: true,
        changed: true,
        promotedTools: ['repo_status'],
        message: 'ok',
      })),
      removePromotedExtendedTool: vi.fn(() => ({
        ok: true,
        changed: true,
        promotedTools: [],
        message: 'ok',
      })),
      swapPromotedExtendedTools: vi.fn(() => ({
        ok: true,
        changed: true,
        promotedTools: ['repo_status'],
        message: 'ok',
      })),
    };

    wireSettingsRuntime(target as any, {} as any);

    const calls = target.registerTool.mock.calls as Array<[any, string]>;
    expect(calls.map(([tool]) => tool.name)).toEqual(['system']);
    expect(calls.find(([tool]) => tool.name === 'system')?.[1]).toBe('core');
  });
});

describe('wirePromptRuntime', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'prompt-runtime-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers unified identity as core and north_star as extended', () => {
    const target = {
      promptComposer: null,
      registerTool: vi.fn(),
    };

    wirePromptRuntime(target as any, tempDir, 'Base prompt');

    const calls = target.registerTool.mock.calls as Array<[any, string]>;
    expect(calls.map(([tool]) => tool.name)).toEqual(['identity', 'north_star']);
    expect(calls.find(([tool]) => tool.name === 'identity')?.[1]).toBe('core');
    expect(calls.find(([tool]) => tool.name === 'north_star')?.[1]).toBe('extended');
  });
});

describe('wireFilesystemToolsRuntime', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'filesystem-tools-runtime-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers fs as a core tool', () => {
    const target = {
      registerTool: vi.fn(),
    };

    wireFilesystemToolsRuntime(target as any, tempDir);

    const calls = target.registerTool.mock.calls as Array<[any, string]>;
    expect(calls.map(([tool]) => tool.name)).toEqual(['fs']);
    expect(calls.every(([, category]) => category === 'core')).toBe(true);
  });
});

describe('wireExtendedToolAutoloadPolicy', () => {
  it('applies default autoload policy when no override is provided', () => {
    const target = {
      setExtendedToolAutoloadPolicy: vi.fn(),
    };

    wireExtendedToolAutoloadPolicy(target);

    expect(target.setExtendedToolAutoloadPolicy).toHaveBeenCalledTimes(1);
    const policy = target.setExtendedToolAutoloadPolicy.mock.calls[0]?.[0];
    expect(policy.maxPreloadCount).toBeGreaterThan(0);
    expect(policy.classifyIntent({
      channelId: 'discord-dev',
      channelType: 'discord',
      content: 'check git diff',
    })).toBe('dev');
  });

  it('uses caller-provided policy override', () => {
    const target = {
      setExtendedToolAutoloadPolicy: vi.fn(),
    };
    const customPolicy = createDefaultExtendedToolAutoloadPolicy(1);

    wireExtendedToolAutoloadPolicy(target, customPolicy);

    expect(target.setExtendedToolAutoloadPolicy).toHaveBeenCalledWith(customPolicy);
  });
});

describe('wireHeartbeatRuntime', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'heartbeat-runtime-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers reflection tasks using template cadence', () => {
    const store = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
    const policy = store.load();
    const dailyReview = policy.templates.find(template => template.id === 'daily-review');
    if (!dailyReview) {
      throw new Error('daily-review template missing');
    }
    dailyReview.cadence = { kind: 'daily', hour: 7, minute: 30, timezone: 'utc' };
    store.save(policy);

    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'reflection output' }),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
    );

    const task = scheduler.getTask('reflection:daily-review');
    expect(task).toBeDefined();
    expect(task?.cadence).toEqual({ kind: 'daily', hour: 7, minute: 30, timezone: 'utc' });
  });

  it('registers schedule as the canonical core surface without split heartbeat policy tools', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'reflection output' }),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
      undefined,
      { eventBus },
    );

    const calls = target.registerTool.mock.calls as Array<[any, string]>;
    expect(calls.find(([tool]) => tool.name === 'schedule')?.[1]).toBe('core');
    expect(calls.some(([tool]) => tool.name === 'heartbeat_get_policy')).toBe(false);
    expect(calls.some(([tool]) => tool.name === 'heartbeat_update_policy')).toBe(false);
    expect(calls.some(([tool]) => tool.name === 'heartbeat_run_template')).toBe(false);
    expect(calls.some(([tool]) => tool.name === 'schedule_task')).toBe(false);

    const scheduleTool = calls.find(([tool]) => tool.name === 'schedule')?.[0] as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }>;
    };
    const result = await scheduleTool.execute('call-schedule-list-templates', { action: 'list_templates' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Reflection Schedule Policy');
    expect(text).toContain('Templates:');
  });

  it('keeps all values actions behind orient instead of registering direct values tools', () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'reflection output' }),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
    );

    const calls = target.registerTool.mock.calls as Array<[any, string]>;
    const names = calls.map(([tool]) => tool.name);
    expect(names).not.toContain('values_list');
    expect(names).not.toContain('values_add');
    expect(names).not.toContain('values_update');
    expect(names).toEqual(['schedule']);
  });

  it('writes versioned values entries when weekly reflection task runs', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const narrative = createInternalStateNarrativeFixture();
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({
        content: 'Values reflection body',
        metadata: {
          internalState: narrative.internalState,
          internalStateSnapshotRef: narrative.snapshotRef,
          metacognitiveFlags: narrative.metacognitiveFlags,
        },
      }),
      getCurrentInternalState: vi.fn(() => narrative.internalState),
      getCurrentInternalStateSnapshotRef: vi.fn(() => narrative.snapshotRef),
      getCurrentMetacognitiveFlags: vi.fn(() => narrative.metacognitiveFlags),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
      );

      const task = scheduler.getTask('reflection:weekly-review');
      expect(task).toBeDefined();
      expect(task?.intervalMs).toBe(7 * 24 * 60 * 60_000);

      nowSpy.mockReturnValue(1_700_000_000_000 + task!.intervalMs + 1);
      await scheduler.tick();

      const raw = readFileSync(resolveValuesJournalPath(tempDir), 'utf-8').trim();
      const lines = raw.split('\n');
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0] ?? '{}') as {
        version: number;
        templateId: string;
        templateName: string;
        reflection: string;
        telemetry?: {
          narrativeContext?: {
            internalStateSnapshotRef?: string;
            internalState?: unknown;
            metacognitiveFlags?: Array<{ flag: string; confidence: number; evidence?: string }>;
          };
        };
      };
      expect(entry.version).toBe(1);
      expect(entry.templateId).toBe('weekly-review');
      expect(entry.templateName).toBe('Weekly Reflection');
      expect(entry.reflection).toContain('Values reflection body');
      expect(entry.telemetry?.narrativeContext?.internalStateSnapshotRef).toBe(narrative.snapshotRef);
      expect(entry.telemetry?.narrativeContext?.internalState).toEqual(narrative.internalState);
      expect(entry.telemetry?.narrativeContext?.metacognitiveFlags).toEqual(narrative.metacognitiveFlags);

      const valuesCall = (agentLoop.handleMessage as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0]?.channelId === 'internal:reflection:weekly-review',
      );
      expect(valuesCall?.[0]?.content).toContain('[Reflection Self Evidence]');
      expect(valuesCall?.[0]?.content).toContain('[Reflection Evidence Boundary]');
      expect(valuesCall?.[0]?.content).not.toContain('serialized_internal_state:');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('runs deliberation mode and persists journal telemetry metadata', async () => {
    const store = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(tempDir));
    const policy = store.load();
    const values = policy.templates.find(template => template.id === 'weekly-review');
    if (!values) {
      throw new Error('weekly-review template missing');
    }
    values.mode = 'deliberation';
    values.deliberation = {
      maxRounds: 1,
      maxTotalTokens: 4000,
      maxWallTimeMs: 30_000,
      voices: ['reasoning', 'background'],
    };
    store.save(policy);

    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const narrative = createInternalStateNarrativeFixture();
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'fallback response' }),
      getCurrentInternalState: vi.fn(() => narrative.internalState),
      getCurrentInternalStateSnapshotRef: vi.fn(() => narrative.snapshotRef),
      getCurrentMetacognitiveFlags: vi.fn(() => narrative.metacognitiveFlags),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    const purposes: string[] = [];
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
        purposes.push(purpose);
        const promptBody = context.messages?.map((message) => message.content).join('\n\n') ?? '';
        const responses = {
          reasoning: {
            content: promptBody.includes('Synthesize the strongest insights into one coherent reflection')
              ? 'A single synthesized values reflection.'
              : 'Reasoning voice: continuity and trust matter.',
            inputTokens: 30,
            outputTokens: 40,
          },
          background: {
            content: 'Background voice: steadiness and care matter.',
            inputTokens: 20,
            outputTokens: 30,
          },
          extraction: {
            content: '',
            inputTokens: 0,
            outputTokens: 0,
          },
          summary: {
            content: '',
            inputTokens: 0,
            outputTokens: 0,
          },
        } as const;
        const selected = responses[purpose];
        return {
          content: selected.content,
          toolCalls: [],
          model: `mock-${purpose}`,
          inputTokens: selected.inputTokens,
          outputTokens: selected.outputTokens,
          stopReason: 'stop',
        };
      }),
    };
    const memoryWriter = {
      write: vi.fn().mockResolvedValue({
        action: 'created',
        memory: { id: 'mem-1' },
      }),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          llmProvider,
          characterPromptVariablesProvider: () => ({
            'character.visual_description': 'hands with cat ears and tail',
          }),
          memoryWriter,
        },
      );

      const task = scheduler.getTask('reflection:weekly-review');
      expect(task).toBeDefined();

      nowSpy.mockReturnValue(1_700_000_000_000 + task!.intervalMs + 1);
      await scheduler.tick();

      const handledChannels = (agentLoop.handleMessage as ReturnType<typeof vi.fn>).mock.calls
        .map(call => call[0]?.channelId);
      expect(handledChannels).not.toContain('internal:reflection:weekly-review');
      const valuesDeliberationCalls = (llmProvider.complete as ReturnType<typeof vi.fn>).mock.calls
        .filter((call) => (
          typeof call[0]?.messages?.[0]?.content === 'string'
          && call[0].messages[0].content.includes('durable values and north-star signals')
        ));
      expect(valuesDeliberationCalls.map((call) => call[1])).toEqual(['reasoning']);
      const firstDeliberationCall = valuesDeliberationCalls[0]?.[0] as
        | {
          messages?: Array<{ content?: string }>;
          correlation?: { callType?: string; originType?: string; originStage?: string; channelId?: string };
        }
        | undefined;
      expect(firstDeliberationCall?.messages?.[0]?.content).not.toContain(
        '<appearance_context>',
      );
      expect(firstDeliberationCall?.messages?.[0]?.content).toContain('[Reflection Self Evidence]');
      expect(firstDeliberationCall?.messages?.[0]?.content).not.toContain(`snapshot_ref: ${narrative.snapshotRef}`);
      expect(firstDeliberationCall?.correlation).toMatchObject({
        callType: 'scheduled',
        originType: 'scheduled',
        originStage: 'heartbeat.deliberation.evidence',
        channelId: 'internal:reflection:weekly-review',
      });
      expect(memoryWriter.write).toHaveBeenCalledWith(expect.objectContaining({
        sourceRef: expect.stringContaining('source:heartbeat|template:weekly-review|mode:deliberation'),
        tags: expect.arrayContaining(['heartbeat', 'reflection', 'deliberation', 'weekly-review']),
      }));

      const raw = readFileSync(resolveValuesJournalPath(tempDir), 'utf-8').trim();
      const entry = JSON.parse(raw) as {
        reflection: string;
        telemetry?: {
          deliberation?: {
            rounds: number;
            totalTokens: number;
            estimatedCostUsd: number;
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
          narrativeContext?: {
            internalStateSnapshotRef?: string;
            internalState?: unknown;
            metacognitiveFlags?: Array<{ flag: string; confidence: number; evidence?: string }>;
          };
        };
      };
      expect(entry.reflection).toContain('Reasoning voice: continuity and trust matter.');
      expect(entry.telemetry?.narrativeContext?.internalStateSnapshotRef).toBe(narrative.snapshotRef);
      expect(entry.telemetry?.narrativeContext?.internalState).toEqual(narrative.internalState);
      expect(entry.telemetry?.narrativeContext?.metacognitiveFlags).toEqual(narrative.metacognitiveFlags);
      expect(entry.telemetry?.deliberation?.rounds).toBe(1);
      expect(entry.telemetry?.deliberation?.totalTokens).toBe(70);
      expect(entry.telemetry?.deliberation?.estimatedCostUsd).toBeGreaterThan(0);
      expect(entry.telemetry?.deliberation?.episode).toMatchObject({
        budget: {
          maxRounds: 1,
          maxTotalTokens: 4000,
          maxWallTimeMs: 30000,
        },
        exit: {
          reason: 'max_rounds',
          exhaustedBudget: true,
          maxRoundsReached: true,
        },
      });

      const reflectionRaw = readFileSync(resolveReflectionJournalPath(tempDir), 'utf-8').trim();
      const reflectionLines = reflectionRaw.split('\n').filter(line => line.trim().length > 0);
      expect(reflectionLines.length).toBeGreaterThan(0);
      const reflectionEntry = JSON.parse(reflectionLines[reflectionLines.length - 1] ?? '{}') as {
        mode: string;
        templateId: string;
        telemetry?: {
          deliberation?: {
            episode?: {
              budget?: { maxRounds?: number };
              exit?: { reason?: string; maxRoundsReached?: boolean };
            };
          };
          narrativeContext?: {
            internalStateSnapshotRef?: string;
          };
        };
      };
      expect(reflectionEntry.templateId).toBe('weekly-review');
      expect(reflectionEntry.mode).toBe('deliberation');
      expect(reflectionEntry.telemetry?.narrativeContext?.internalStateSnapshotRef).toBe(narrative.snapshotRef);
      expect(reflectionEntry.telemetry?.deliberation?.episode).toMatchObject({
        budget: { maxRounds: 1 },
        exit: { reason: 'max_rounds', maxRoundsReached: true },
      });

      const metacognitionRaw = readFileSync(resolveReflectionMetacognitionJournalPath(tempDir), 'utf-8').trim();
      const metacognitionLines = metacognitionRaw.split('\n').filter(line => line.trim().length > 0);
      const metacognitionEntry = JSON.parse(metacognitionLines[metacognitionLines.length - 1] ?? '{}') as {
        kind: string;
        executionSource: string;
        initiatorSurface: string;
        reason?: string;
        reflectionJournalEntryId?: string;
        prompt?: string;
      };
      expect(metacognitionEntry.kind).toBe('reflection_run');
      expect(metacognitionEntry.executionSource).toBe('scheduled');
      expect(metacognitionEntry.initiatorSurface).toBe('scheduler:reflection_template');
      expect(metacognitionEntry.reason).toBe('Scheduled reflection run');
      expect(metacognitionEntry.reflectionJournalEntryId).toBeDefined();
      expect(metacognitionEntry.prompt).toContain('[Reflection Self Evidence]');
      expect(metacognitionEntry.prompt).not.toContain('serialized_internal_state:');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('injects InternalState narrative payload for daily reflection template runs', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const narrative = createInternalStateNarrativeFixture();
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'Experiential reflection body' }),
      getCurrentInternalState: vi.fn(() => narrative.internalState),
      getCurrentInternalStateSnapshotRef: vi.fn(() => narrative.snapshotRef),
      getCurrentMetacognitiveFlags: vi.fn(() => narrative.metacognitiveFlags),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
    );

    const registeredTools = target.registerTool.mock.calls.map(call => call[0]);
    const runTemplateTool = registeredTools.find((tool: { name?: string }) => tool.name === 'schedule');
    expect(runTemplateTool).toBeDefined();

    const runResult = await runTemplateTool.execute(
      'manual-daily-review',
      { action: 'run_template', template_id: 'daily-review', defer_if_busy: false },
      new AbortController().signal,
    );
    const runText = runResult.content.map((part: { text: string }) => part.text).join('');
    expect(runText).toContain('Triggered reflection template "Daily Reflection" (daily-review).');

    const experientialCall = (agentLoop.handleMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.channelId === 'internal:reflection:daily-review',
    );
    expect(experientialCall).toBeDefined();
    expect(experientialCall?.[0]?.content).toContain('[Reflection Self Evidence]');
    expect(experientialCall?.[0]?.content).not.toContain(`snapshot_ref: ${narrative.snapshotRef}`);
    expect(experientialCall?.[0]?.content).toContain('[Recent Metacognitive Flags]');
    expect(experientialCall?.[0]?.content).toContain('[Active Concerns]');
  });

  it('defers manual template runs when the agent is busy and executes them after idle', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const narrative = createInternalStateNarrativeFixture();
    const agentLoop = {
      handleMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('Agent is already processing another prompt'))
        .mockResolvedValue({ content: 'Deferred reflection output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      getCurrentInternalState: vi.fn(() => narrative.internalState),
      getCurrentInternalStateSnapshotRef: vi.fn(() => narrative.snapshotRef),
      getCurrentMetacognitiveFlags: vi.fn(() => narrative.metacognitiveFlags),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
      );

      const registeredTools = target.registerTool.mock.calls.map(call => call[0]);
      const runTemplateTool = registeredTools.find((tool: { name?: string }) => tool.name === 'schedule');
      expect(runTemplateTool).toBeDefined();

      const runResult = await runTemplateTool.execute(
        'manual-1',
        { action: 'run_template', template_id: 'daily-review' },
        new AbortController().signal,
      );
      const runText = runResult.content.map((part: { text: string }) => part.text).join('');
      expect(runText).toContain('Queued manual reflection run "Daily Reflection" (daily-review) for post-turn execution.');

      const deferredTask = scheduler.listTasks().find(task => task.id.startsWith('reflection-run:deferred:'));
      expect(deferredTask).toBeDefined();

      nowSpy.mockReturnValue((deferredTask?.runAt ?? 0) + 1);
      await scheduler.tick();

      expect(agentLoop.waitForIdle).toHaveBeenCalledOnce();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(2);
      expect(agentLoop.handleMessage.mock.calls[1]?.[0]?.channelId).toBe('internal:reflection:daily-review');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('wires post-turn inference/handler runtime when manual run is busy', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const registerPostTurnActionInferer = vi.fn().mockReturnValue(() => {});
    const narrative = createInternalStateNarrativeFixture();
    const agentLoop = {
      handleMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('Agent is already processing another prompt'))
        .mockResolvedValue({ content: 'Deferred reflection output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      registerPostTurnActionInferer,
      getCurrentInternalState: vi.fn(() => narrative.internalState),
      getCurrentInternalStateSnapshotRef: vi.fn(() => narrative.snapshotRef),
      getCurrentMetacognitiveFlags: vi.fn(() => narrative.metacognitiveFlags),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const postTurnActions = {
      registerHandler: vi.fn().mockReturnValue(() => {}),
      listQueued: vi.fn().mockReturnValue([]),
      getStatus: vi.fn(),
    };

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
      undefined,
      {
        eventBus,
        postTurnActions,
      },
    );

    expect(postTurnActions.registerHandler).toHaveBeenCalledTimes(2);
    const heartbeatRegisterCall = postTurnActions.registerHandler.mock.calls.find(
      (call) => call[0] === 'heartbeat.run_template',
    );
    expect(heartbeatRegisterCall).toBeDefined();
    expect(registerPostTurnActionInferer).toHaveBeenCalledTimes(1);
    const inferer = registerPostTurnActionInferer.mock.calls[0]?.[0] as (
      context: {
        message: { id: string; channelId: string };
        response: { content: string };
        turnMessages: unknown[];
      },
    ) => Promise<Array<{ kind: string; dedupeKey?: string; payload?: Record<string, unknown> }>>;
    const inferredActions = await inferer({
      message: { id: 'msg-1', channelId: 'test-channel' },
      response: { content: 'ok' },
      turnMessages: [{
        role: 'toolResult',
        toolName: 'schedule',
        result: {
          details: {
            deferredAction: {
              kind: 'heartbeat.run_template',
              payload: { templateId: 'daily-review' },
              dedupeKey: 'heartbeat.run_template:daily-review',
              maxRetries: 2,
            },
          },
        },
      }],
    });
    expect(inferredActions).toEqual([{
      kind: 'heartbeat.run_template',
      payload: { templateId: 'daily-review' },
      dedupeKey: 'heartbeat.run_template:daily-review',
      maxRetries: 2,
    }]);

    const registeredTools = target.registerTool.mock.calls.map(call => call[0]);
    const runTemplateTool = registeredTools.find((tool: { name?: string }) => tool.name === 'schedule');
    expect(runTemplateTool).toBeDefined();

    const runResult = await runTemplateTool.execute(
      'manual-2',
      { action: 'run_template', template_id: 'daily-review' },
      new AbortController().signal,
    );
    const runText = runResult.content.map((part: { text: string }) => part.text).join('');
    expect(runText).toContain('Queued manual reflection run "Daily Reflection" (daily-review) for post-turn execution.');
    expect((runResult.details as { deferredAction?: { kind?: string } }).deferredAction?.kind)
      .toBe('heartbeat.run_template');

    const deferredTask = scheduler.listTasks().find(task => task.id.startsWith('reflection-run:deferred:'));
    expect(deferredTask).toBeUndefined();

    const deferredHandler = heartbeatRegisterCall?.[1] as (
      action: {
        id: string;
        kind: string;
        payload: Record<string, unknown>;
        dedupeKey: string;
        channelId: string;
        sourceMessageId: string;
        inferredAt: number;
      },
    ) => Promise<void>;
    await deferredHandler({
      id: 'deferred-1',
      kind: 'heartbeat.run_template',
      payload: { templateId: 'daily-review' },
      dedupeKey: 'heartbeat.run_template:daily-review',
      channelId: 'test-channel',
      sourceMessageId: 'msg-1',
      inferredAt: Date.now(),
    });

    expect(agentLoop.handleMessage).toHaveBeenCalledTimes(2);
    expect(agentLoop.handleMessage.mock.calls[1]?.[0]?.channelId).toBe('internal:reflection:daily-review');
  });

  it('gates composed post-turn appraisal by compositional policy', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const duplicateTurnMessages = [{
      role: 'toolResult',
      toolName: 'load_tools',
      result: {
        details: {
          deferredToolHandoff: {
            toolNames: ['extended_probe_tool'],
            intendedAction: 'Use extended_probe_tool to collect diagnostics.',
            maxRetries: 1,
          },
        },
      },
    }, {
      role: 'toolResult',
      toolName: 'load_tools',
      result: {
        details: {
          deferredToolHandoff: {
            toolNames: ['extended_probe_tool'],
            intendedAction: 'Use extended_probe_tool to collect diagnostics.',
            maxRetries: 1,
          },
        },
      },
    }];
    const message = {
      id: 'msg-dup-1',
      channelId: 'api:test',
      channelType: 'terminal' as const,
      authorId: 'user-1',
      authorName: 'Test User',
      content: 'hello',
      timestamp: new Date(),
    };
    const buildInferer = (allowedPurposes: string[]) => {
      const target = { registerTool: vi.fn() };
      const registerPostTurnActionInferer = vi.fn().mockReturnValue(() => {});
      const agentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        activateExtendedTools: vi.fn().mockReturnValue({
          requestedTools: ['extended_probe_tool'],
          activatedTools: ['extended_probe_tool'],
          alreadyActiveTools: [],
          missingTools: [],
        }),
        registerPostTurnActionInferer,
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const postTurnActions = {
        registerHandler: vi.fn().mockReturnValue(() => {}),
        listQueued: vi.fn().mockReturnValue([]),
        getStatus: vi.fn(),
      };

      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
          capabilityTier: 'autonomous',
          compositionalPolicy: {
            enabled: true,
            allowedTiers: ['autonomous'],
            allowedChannelTypes: ['api'],
            allowedPurposes,
          },
        },
      );

      return registerPostTurnActionInferer.mock.calls[0]?.[0] as (
        context: {
          message: typeof message;
          response: { content: string };
          turnMessages: unknown[];
        },
      ) => Promise<Array<any>>;
    };

    const composedInferer = buildInferer(['appraisal']);
    const legacyInferer = buildInferer(['retrieval']);

    const composedActions = await composedInferer({
      message,
      response: { content: 'ok' },
      turnMessages: duplicateTurnMessages,
    });
    const legacyActions = await legacyInferer({
      message,
      response: { content: 'ok' },
      turnMessages: duplicateTurnMessages,
    });

    expect(composedActions).toHaveLength(1);
    expect(legacyActions).toHaveLength(2);
  });

  it('suppresses rapid-fire deferred heartbeat template execution loops', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const narrative = createInternalStateNarrativeFixture();
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'Loop candidate reflection output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      registerPostTurnActionInferer: vi.fn().mockReturnValue(() => {}),
      getCurrentInternalState: vi.fn(() => narrative.internalState),
      getCurrentInternalStateSnapshotRef: vi.fn(() => narrative.snapshotRef),
      getCurrentMetacognitiveFlags: vi.fn(() => narrative.metacognitiveFlags),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const postTurnActions = {
      registerHandler: vi.fn().mockReturnValue(() => {}),
      listQueued: vi.fn().mockReturnValue([]),
      getStatus: vi.fn(),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_100_000);
      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
        },
      );

      const heartbeatRegisterCall = postTurnActions.registerHandler.mock.calls.find(
        (call) => call[0] === 'heartbeat.run_template',
      );
      expect(heartbeatRegisterCall).toBeDefined();

      const deferredHandler = heartbeatRegisterCall?.[1] as (
        action: {
          id: string;
          kind: string;
          payload: Record<string, unknown>;
          dedupeKey: string;
          channelId: string;
          sourceMessageId: string;
          inferredAt: number;
        },
      ) => Promise<void>;

      for (let index = 0; index < 6; index += 1) {
        const now = 1_700_000_100_000 + index * 1_000;
        nowSpy.mockReturnValue(now);
        await deferredHandler({
          id: `deferred-loop-${index}`,
          kind: 'heartbeat.run_template',
          payload: { templateId: 'daily-review' },
          dedupeKey: `heartbeat.run_template:daily-review:${index}`,
          channelId: 'test-channel',
          sourceMessageId: `msg-loop-${index}`,
          inferredAt: now,
        });
      }

      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(4);
      const handledChannels = agentLoop.handleMessage.mock.calls.map(call => call[0]?.channelId);
      expect(handledChannels).toEqual([
        'internal:reflection:daily-review',
        'internal:reflection:daily-review',
        'internal:reflection:daily-review',
        'internal:reflection:daily-review',
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('infers deferred tool-handoff actions from late load_tools discovery payloads', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const registerPostTurnActionInferer = vi.fn().mockReturnValue(() => {});
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      activateExtendedTools: vi.fn().mockReturnValue({
        requestedTools: ['extended_probe_tool'],
        activatedTools: ['extended_probe_tool'],
        alreadyActiveTools: [],
        missingTools: [],
      }),
      registerPostTurnActionInferer,
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const postTurnActions = {
      registerHandler: vi.fn().mockReturnValue(() => {}),
      listQueued: vi.fn().mockReturnValue([]),
      getStatus: vi.fn(),
    };

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
      undefined,
      {
        eventBus,
        postTurnActions,
      },
    );

    const inferer = registerPostTurnActionInferer.mock.calls[0]?.[0] as (
      context: {
        message: {
          id: string;
          channelId: string;
          channelType: 'terminal';
          authorId: string;
          authorName: string;
          content: string;
          timestamp: Date;
        };
        response: { content: string };
        turnMessages: unknown[];
      },
    ) => Promise<Array<{
      kind: string;
      payload?: {
        toolNames?: string[];
        intendedAction?: string;
        turn?: {
          turnId?: string;
          requestId?: string;
          channelId?: string;
          channelType?: string;
          callType?: string;
        };
      };
      dedupeKey?: string;
      maxRetries?: number;
    }>>;
    const inferredActions = await inferer({
      message: {
        id: 'msg-1',
        channelId: 'test-channel',
        channelType: 'terminal',
        authorId: 'user-1',
        authorName: 'Test User',
        content: 'hello',
        timestamp: new Date(),
      },
      response: { content: 'ok' },
      turnMessages: [{
        role: 'toolResult',
        toolName: 'load_tools',
        result: {
          details: {
            deferredToolHandoff: {
              toolNames: ['extended_probe_tool'],
              intendedAction: 'Use extended_probe_tool to collect diagnostics.',
              maxRetries: 1,
            },
          },
        },
      }],
    });

    expect(inferredActions).toHaveLength(1);
    expect(inferredActions[0]).toMatchObject({
      kind: DEFERRED_TOOL_HANDOFF_ACTION_KIND,
      maxRetries: 1,
      payload: {
        toolNames: ['extended_probe_tool'],
        intendedAction: 'Use extended_probe_tool to collect diagnostics.',
        turn: {
          turnId: 'msg-1',
          requestId: 'msg-1',
          channelId: 'test-channel',
          channelType: 'terminal',
          callType: 'chat',
        },
      },
    });
    expect(inferredActions[0]?.dedupeKey).toContain(`${DEFERRED_TOOL_HANDOFF_ACTION_KIND}:msg-1:`);
  });

  it('continues deferred tool handoff in background and emits queued/activated/executed telemetry', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const registerPostTurnActionInferer = vi.fn().mockReturnValue(() => {});
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'Deferred continuation output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      activateExtendedTools: vi.fn().mockReturnValue({
        requestedTools: ['extended_probe_tool'],
        activatedTools: ['extended_probe_tool'],
        alreadyActiveTools: [],
        missingTools: [],
      }),
      registerPostTurnActionInferer,
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const postTurnActions = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop,
      intervalMs: 1,
    });

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
      undefined,
      {
        eventBus,
        postTurnActions,
      },
    );

    const inferer = registerPostTurnActionInferer.mock.calls[0]?.[0] as (
      context: {
        message: {
          id: string;
          channelId: string;
          channelType: 'terminal';
          authorId: string;
          authorName: string;
          content: string;
          timestamp: Date;
        };
        response: { content: string };
        turnMessages: unknown[];
      },
    ) => Promise<Array<any>>;
    const message = {
      id: 'msg-load-tools-1',
      channelId: 'test-channel',
      channelType: 'terminal' as const,
      authorId: 'user-1',
      authorName: 'Test User',
      content: 'hello',
      timestamp: new Date(),
    };
    const inferredActions = await inferer({
      message,
      response: { content: 'ok' },
      turnMessages: [{
        role: 'toolResult',
        toolName: 'load_tools',
        result: {
          details: {
            deferredToolHandoff: {
              toolNames: ['extended_probe_tool'],
              intendedAction: 'Use extended_probe_tool to collect diagnostics.',
              maxRetries: 1,
            },
          },
        },
      }],
    });

    const phases: string[] = [];
    eventBus.on('agent.tool_handoff.telemetry', ({ phase }) => {
      phases.push(phase);
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message,
      response: {
        content: 'ok',
        channelId: message.channelId,
        metadata: {
          model: 'mock-model',
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1,
        },
      },
      actions: inferredActions,
    });

    await scheduler.tick();

    expect(agentLoop.waitForIdle).not.toHaveBeenCalled();
    expect(agentLoop.activateExtendedTools).toHaveBeenCalledTimes(1);
    expect(agentLoop.activateExtendedTools).toHaveBeenCalledWith(
      ['extended_probe_tool'],
      expect.objectContaining({
        source: 'deferred',
        correlation: expect.objectContaining({
          callType: 'tool',
          purpose: 'agent.tools.adaptive.decision',
        }),
        taskKind: 'deferred_tool_handoff',
        intent: 'deferred_tool_handoff',
      }),
    );
    expect(agentLoop.handleMessage).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith('test-channel', 'Deferred continuation output');
    expect(phases).toEqual(['queued', 'activated', 'executed']);
  });

  it('bounds deferred tool-handoff retries and emits failed telemetry once exhausted', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);

      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const target = {
        registerTool: vi.fn(),
      };
      const registerPostTurnActionInferer = vi.fn().mockReturnValue(() => {});
      const agentLoop = {
        handleMessage: vi.fn().mockRejectedValue(new Error('continuation failed')),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        activateExtendedTools: vi.fn().mockReturnValue({
          requestedTools: ['extended_probe_tool'],
          activatedTools: ['extended_probe_tool'],
          alreadyActiveTools: [],
          missingTools: [],
        }),
        registerPostTurnActionInferer,
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const postTurnActions = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
        baseRetryDelayMs: 10,
        maxRetryDelayMs: 10,
      });

      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
        },
      );

      const inferer = registerPostTurnActionInferer.mock.calls[0]?.[0] as (
        context: {
          message: {
            id: string;
            channelId: string;
            channelType: 'terminal';
            authorId: string;
            authorName: string;
            content: string;
            timestamp: Date;
          };
          response: { content: string };
          turnMessages: unknown[];
        },
      ) => Promise<Array<any>>;
      const message = {
        id: 'msg-load-tools-fail-1',
        channelId: 'test-channel',
        channelType: 'terminal' as const,
        authorId: 'user-1',
        authorName: 'Test User',
        content: 'hello',
        timestamp: new Date(),
      };
      const inferredActions = await inferer({
        message,
        response: { content: 'ok' },
        turnMessages: [{
          role: 'toolResult',
          toolName: 'load_tools',
          result: {
            details: {
              deferredToolHandoff: {
                toolNames: ['extended_probe_tool'],
                intendedAction: 'Use extended_probe_tool to collect diagnostics.',
                maxRetries: 1,
              },
            },
          },
        }],
      });

      const phases: string[] = [];
      eventBus.on('agent.tool_handoff.telemetry', ({ phase }) => {
        phases.push(phase);
      });

      nowSpy.mockReturnValue(1_700_000_000_101);
      await eventBus.emit('agent.post_turn.actions.inferred', {
        message,
        response: {
          content: 'ok',
          channelId: message.channelId,
          metadata: {
            model: 'mock-model',
            inputTokens: 1,
            outputTokens: 1,
            durationMs: 1,
          },
        },
        actions: inferredActions,
      });

      await scheduler.tick();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(1);
      expect(agentLoop.activateExtendedTools).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_700_000_000_150);
      await scheduler.tick();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_700_000_000_250);
      await scheduler.tick();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(2);
      expect(agentLoop.activateExtendedTools).toHaveBeenCalledTimes(1);
      expect(agentLoop.waitForIdle).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
      expect(phases).toEqual(['queued', 'activated', 'failed']);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('defers scheduled template runs when the agent is busy and executes after idle', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const narrative = createInternalStateNarrativeFixture();
    const agentLoop = {
      handleMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('Agent is already processing another prompt'))
        .mockResolvedValue({ content: 'Deferred scheduled output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      getCurrentInternalState: vi.fn(() => narrative.internalState),
      getCurrentInternalStateSnapshotRef: vi.fn(() => narrative.snapshotRef),
      getCurrentMetacognitiveFlags: vi.fn(() => narrative.metacognitiveFlags),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
      );

      const dailyTask = scheduler.getTask('reflection:daily-review');
      expect(dailyTask).toBeDefined();

      nowSpy.mockReturnValue(1_700_000_000_000 + (dailyTask?.intervalMs ?? 0) + 1);
      await scheduler.tick();

      const deferredTask = scheduler.listTasks().find(task => task.id.startsWith('reflection-run:deferred:scheduled:daily-review'));
      expect(deferredTask).toBeDefined();

      nowSpy.mockReturnValue((deferredTask?.runAt ?? 0) + 1);
      await scheduler.tick();

      expect(agentLoop.waitForIdle).toHaveBeenCalledOnce();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(2);
      expect(agentLoop.handleMessage.mock.calls[1]?.[0]?.channelId).toBe('internal:reflection:daily-review');
    } finally {
      nowSpy.mockRestore();
    }
  });
});
