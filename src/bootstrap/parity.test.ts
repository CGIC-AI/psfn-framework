import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { HeartbeatPolicyStore } from '../scheduler/heartbeat-policy.js';
import type { LLMProvider } from '../agent/contracts.js';
import { readLastActiveSession } from '../lifecycle/notifications.js';
import { createDefaultExtendedToolAutoloadPolicy } from '../agent/extended-tool-autoload-policy.js';
import { buildInternalStateSnapshotRef, InternalStateComputer } from '../self-model/state.js';
import { ReflectionJournalStore } from '../notes/reflection-journal.js';
import {
  buildReflectionProcessId,
  ReflectionDailyJournalStore,
  ReflectionProcessLogStore,
  toReflectionDailyJournalProvenanceRef,
  toReflectionJournalProvenanceRef,
  toReflectionProcessLogProvenanceRef,
} from '../notes/reflection-substrate.js';
import { resolvePromptLayersPath } from '../persistence/layout.js';
import {
  wireFilesystemToolsRuntime,
  wireExtendedToolAutoloadPolicy,
  wirePromptRuntime,
  wireSessionToolsRuntime,
  wireSettingsRuntime,
} from './parity.js';
import { wirePostTurnActionRuntime } from './post-turn-actions.js';
import { DEFERRED_TOOL_HANDOFF_ACTION_KIND } from '../agent/deferred-tool-handoff.js';
import { PendingFollowUpStore } from '../intention/pending-follow-ups.js';
import { CareReminderStore } from '../intention/care-reminders.js';
import { wireHeartbeatRuntime } from '../scheduler/heartbeat-runtime.js';

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

  it('registers session search/list tools in core and session mutations in extended', async () => {
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
    expect(calls[0]?.[1]).toBe('core');

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
      'Session initialized via session_new.',
    );

    const active = readLastActiveSession(tempDir);
    expect(active?.sessionId).toBe(details.newSessionId);
    expect(active?.channelType).toBe('api');
  });
});

describe('wireSettingsRuntime', () => {
  it('registers only system and leaves toolset registration to the agent runtime', () => {
    const target = {
      registerTool: vi.fn(),
      setToolsetMemoryWriter: vi.fn(),
    };

    wireSettingsRuntime(target as any, {} as any);

    const calls = target.registerTool.mock.calls as Array<[any, string]>;
    expect(calls.map(([tool]) => tool.name)).toEqual(['system']);
    expect(calls.find(([tool]) => tool.name === 'system')?.[1]).toBe('core');
    expect(target.setToolsetMemoryWriter).not.toHaveBeenCalled();
  });

  it('forwards the toolset memory writer hook when available', () => {
    const memoryWriter = {
      write: vi.fn(async (input: Record<string, unknown>) => ({
        action: 'created',
        memory: { id: 'memory-1', ...input },
      })),
    };
    const target = {
      registerTool: vi.fn(),
      setToolsetMemoryWriter: vi.fn(),
    };

    wireSettingsRuntime(target as any, {} as any, {
      getMemoryWriter: () => memoryWriter as any,
    });
    expect(target.setToolsetMemoryWriter).toHaveBeenCalledTimes(1);
    const forwardedGetter = target.setToolsetMemoryWriter.mock.calls[0]?.[0] as (() => unknown) | undefined;
    expect(forwardedGetter).toBeTypeOf('function');
    expect(forwardedGetter?.()).toBe(memoryWriter);
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

  it('registers unified identity in core and keeps north-star mutations extended', () => {
    const target = {
      promptComposer: null,
      registerTool: vi.fn(),
    };

    wirePromptRuntime(target as any, tempDir, 'Base prompt');

    const calls = target.registerTool.mock.calls as Array<[any, string]>;
    expect(calls.find(([tool]) => tool.name === 'identity')?.[1]).toBe('core');
    expect(calls.find(([tool]) => tool.name === 'north_star')?.[1]).toBe('extended');
    expect(
      calls
        .filter(([tool]) => tool.name !== 'identity')
        .every(([, category]) => category === 'extended'),
    ).toBe(true);
    expect(calls.map(([tool]) => tool.name)).toEqual(expect.arrayContaining([
      'identity',
      'north_star',
    ]));
  });

  it('fails explicitly when persisted prompt layers are corrupt', () => {
    const target = {
      promptComposer: null,
      registerTool: vi.fn(),
    };
    const promptLayersPath = resolvePromptLayersPath(tempDir);
    writeFileSync(promptLayersPath, '{"broken":', 'utf-8');

    expect(() => wirePromptRuntime(target as any, tempDir, 'Base prompt')).toThrow(
      `Failed to initialize prompt runtime from ${promptLayersPath}:`,
    );
    expect(target.registerTool).not.toHaveBeenCalled();
    expect(target.promptComposer).toBeNull();
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
    const store = new HeartbeatPolicyStore(join(tempDir, 'heartbeat-policy.json'));
    const policy = store.load();
    const whisper = policy.templates.find(template => template.id === 'whisper');
    if (!whisper) {
      throw new Error('whisper template missing');
    }
    whisper.cadence = { kind: 'hourly', minute: 0, timezone: 'utc' };
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

    const task = scheduler.getTask('reflection:whisper');
    expect(task).toBeDefined();
    expect(task?.cadence).toEqual({ kind: 'hourly', minute: 0, timezone: 'utc' });
  });

  it('registers values_list in core and values mutations in extended tools', () => {
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
    expect(names).toEqual(expect.arrayContaining([
      'values_list',
      'values_add',
      'values_update',
    ]));
    expect(calls.find(([tool]) => tool.name === 'values_list')?.[1]).toBe('core');
    expect(
      calls
        .filter(([tool]) => ['values_add', 'values_update'].includes(tool.name))
        .every(([, category]) => category === 'extended'),
    ).toBe(true);
  });

  it('registers unified schedule in core and wires continuity actions to the intention stores', async () => {
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
    const db = new Database(':memory:');
    const pendingFollowUpStore = new PendingFollowUpStore(db);
    const careReminderStore = new CareReminderStore(db);

    try {
      wireHeartbeatRuntime(
        target,
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          pendingFollowUpStore,
          careReminderStore,
        },
      );

      const calls = target.registerTool.mock.calls as Array<[any, string]>;
      expect(calls.find(([tool]) => tool.name === 'schedule')?.[1]).toBe('core');

      const scheduleTool = calls.find(([tool]) => tool.name === 'schedule')?.[0] as any;
      expect(scheduleTool).toBeDefined();

      const followUpResult = await scheduleTool.execute('schedule-follow-up', {
        action: 'create_follow_up',
        content: 'Check back after the appointment tomorrow.',
        channel_id: 'discord:care',
        channel_type: 'discord',
        due_at: '2026-04-03T14:00:00.000Z',
        contact_id: 'contact-z',
      }, new AbortController().signal);
      const followUpPayload = JSON.parse((followUpResult.content[0] as { text: string }).text) as {
        followUp: { id: string };
      };
      expect(pendingFollowUpStore.getById(followUpPayload.followUp.id)).toMatchObject({
        contactId: 'contact-z',
        authorId: 'system:intention',
      });

      const reminderResult = await scheduleTool.execute('schedule-reminder', {
        action: 'create_reminder',
        title: 'Sam birthday',
        content: 'Remember Sam birthday and send a kind note.',
        classification: 'birthday',
        kind: 'important_date',
        reminder_schedule: 'annual',
        due_at: '2026-04-11T09:00:00.000Z',
        channel_id: 'discord:care',
        channel_type: 'discord',
      }, new AbortController().signal);
      const reminderPayload = JSON.parse((reminderResult.content[0] as { text: string }).text) as {
        reminder: { id: string };
      };
      expect(careReminderStore.getById(reminderPayload.reminder.id)).toMatchObject({
        classification: 'birthday',
        provenanceSource: 'companion_appraisal',
      });
    } finally {
      db.close();
    }
  });

  it('writes versioned values entries when values-reflection task runs', async () => {
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

      const task = scheduler.getTask('reflection:values-reflection');
      expect(task).toBeDefined();
      expect(task?.intervalMs).toBe(24 * 60 * 60_000);

      nowSpy.mockReturnValue(1_700_000_000_000 + task!.intervalMs + 1);
      await scheduler.tick();

      const raw = readFileSync(join(tempDir, 'notes', 'values.jsonl'), 'utf-8').trim();
      const lines = raw.split('\n');
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0] ?? '{}') as {
        version: number;
        templateId: string;
        templateName: string;
        reflection: string;
        internalStateSnapshotRef?: string;
        internalState?: unknown;
        metacognitiveFlags?: Array<{ flag: string; confidence: number; evidence?: string }>;
        provenance?: {
          source?: string;
          reflectionJournalEntryId?: string;
        };
      };
      expect(entry.version).toBe(1);
      expect(entry.templateId).toBe('values-reflection');
      expect(entry.templateName).toBe('Values Reflection');
      expect(entry.reflection).toContain('Values reflection body');
      expect(entry.internalStateSnapshotRef).toBe(narrative.snapshotRef);
      expect(entry.internalState).toEqual(narrative.internalState);
      expect(entry.metacognitiveFlags).toEqual(narrative.metacognitiveFlags);
      expect(entry.provenance?.source).toBe('companion_reflection');
      expect(entry.provenance?.reflectionJournalEntryId).toBeDefined();

      const valuesCall = (agentLoop.handleMessage as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0]?.channelId === 'internal:reflection:values-reflection',
      );
      expect(valuesCall?.[0]?.content).toContain('[Internal State Input]');
      expect(valuesCall?.[0]?.content).toContain('serialized_internal_state:');

      const journalDate = new Date(1_700_000_000_000 + task!.intervalMs + 1).toISOString().slice(0, 10);
      const dailyRaw = readFileSync(
        join(tempDir, 'notes', 'reflections', 'daily', `${journalDate}.jsonl`),
        'utf-8',
      ).trim();
      const dailyLines = dailyRaw.split('\n').filter(line => line.trim().length > 0);
      const dailyEntry = JSON.parse(dailyLines[dailyLines.length - 1] ?? '{}') as {
        source?: string;
        executionSource?: string;
        templateId?: string;
      };
      expect(dailyEntry.source).toBe('heartbeat_template');
      expect(dailyEntry.executionSource).toBe('scheduled');
      expect(dailyEntry.templateId).toBe('values-reflection');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('runs deliberation mode and persists journal/memory metadata', async () => {
    const store = new HeartbeatPolicyStore(join(tempDir, 'heartbeat-policy.json'));
    const policy = store.load();
    const values = policy.templates.find(template => template.id === 'values-reflection');
    if (!values) {
      throw new Error('values-reflection template missing');
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
    const llmProvider: LLMProvider = {
      stream: vi.fn(async () => ({
        content: '',
        toolCalls: [],
        model: 'mock-stream',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop',
      })),
      complete: vi.fn(async (_context, purpose) => {
        purposes.push(purpose);
        const responses = {
          reasoning: {
            content: purposes.length === 3
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

      const task = scheduler.getTask('reflection:values-reflection');
      expect(task).toBeDefined();

      nowSpy.mockReturnValue(1_700_000_000_000 + task!.intervalMs + 1);
      await scheduler.tick();

      const handledChannels = (agentLoop.handleMessage as ReturnType<typeof vi.fn>).mock.calls
        .map(call => call[0]?.channelId);
      expect(handledChannels).not.toContain('internal:reflection:values-reflection');
      expect(purposes).toEqual(['reasoning', 'background', 'reasoning']);
      const firstDeliberationCall = (llmProvider.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | { messages?: Array<{ content?: string }> }
        | undefined;
      expect(firstDeliberationCall?.messages?.[0]?.content).toContain(
        'Appearance context:\nhands with cat ears and tail',
      );
      expect(firstDeliberationCall?.messages?.[0]?.content).toContain('[Internal State Input]');
      expect(firstDeliberationCall?.messages?.[0]?.content).toContain(`snapshot_ref: ${narrative.snapshotRef}`);
      expect(memoryWriter.write).toHaveBeenCalledTimes(1);

      const raw = readFileSync(join(tempDir, 'notes', 'values.jsonl'), 'utf-8').trim();
      const entry = JSON.parse(raw) as {
        reflection: string;
        internalStateSnapshotRef?: string;
        internalState?: unknown;
        metacognitiveFlags?: Array<{ flag: string; confidence: number; evidence?: string }>;
        deliberation?: {
          rounds: number;
          totalTokens: number;
          estimatedCostUsd: number;
        };
      };
      expect(entry.reflection).toContain('synthesized values reflection');
      expect(entry.internalStateSnapshotRef).toBe(narrative.snapshotRef);
      expect(entry.internalState).toEqual(narrative.internalState);
      expect(entry.metacognitiveFlags).toEqual(narrative.metacognitiveFlags);
      expect(entry.deliberation?.rounds).toBe(1);
      expect(entry.deliberation?.totalTokens).toBe(190);
      expect(entry.deliberation?.estimatedCostUsd).toBeGreaterThan(0);

      const reflectionRaw = readFileSync(join(tempDir, 'notes', 'reflections', 'journal.jsonl'), 'utf-8').trim();
      const reflectionLines = reflectionRaw.split('\n').filter(line => line.trim().length > 0);
      expect(reflectionLines.length).toBeGreaterThan(0);
      const reflectionEntry = JSON.parse(reflectionLines[reflectionLines.length - 1] ?? '{}') as {
        mode: string;
        templateId: string;
        internalStateSnapshotRef?: string;
      };
      expect(reflectionEntry.templateId).toBe('values-reflection');
      expect(reflectionEntry.mode).toBe('deliberation');
      expect(reflectionEntry.internalStateSnapshotRef).toBe(narrative.snapshotRef);

      const processLogDir = join(tempDir, 'notes', 'reflections', 'process-logs');
      const processLogFiles = readdirSync(processLogDir);
      expect(processLogFiles).toHaveLength(1);
      const processLogRaw = readFileSync(join(processLogDir, processLogFiles[0] ?? ''), 'utf-8').trim();
      const processLogLines = processLogRaw.split('\n').filter(line => line.trim().length > 0);
      expect(processLogLines).toHaveLength(2);
      const processCompletedEntry = JSON.parse(processLogLines[1] ?? '{}') as {
        stage?: string;
        processType?: string;
        deliberation?: { sessionId?: string };
      };
      expect(processCompletedEntry.stage).toBe('completed');
      expect(processCompletedEntry.processType).toBe('reflection_deliberation');
      expect(processCompletedEntry.deliberation?.sessionId).toBeDefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('injects InternalState narrative payload for experiential-review template runs', async () => {
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
    const runTemplateTool = registeredTools.find((tool: { name?: string }) => tool.name === 'heartbeat_run_template');
    expect(runTemplateTool).toBeDefined();

    const runResult = await runTemplateTool.execute(
      'manual-experiential',
      { templateId: 'experiential-review', deferIfBusy: false },
      new AbortController().signal,
    );
    const runText = runResult.content.map((part: { text: string }) => part.text).join('');
    expect(runText).toContain('Triggered reflection template "Experiential Review" (experiential-review).');

    const experientialCall = (agentLoop.handleMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.channelId === 'internal:reflection:experiential-review',
    );
    expect(experientialCall).toBeDefined();
    expect(experientialCall?.[0]?.content).toContain('[Internal State Input]');
    expect(experientialCall?.[0]?.content).toContain(`snapshot_ref: ${narrative.snapshotRef}`);
    expect(experientialCall?.[0]?.content).toContain('[Recent Metacognitive Flags]');
    expect(experientialCall?.[0]?.content).toContain('[Active Concerns]');
  });

  it('replays journal and process substrate into deeper reflection prompts with explicit provenance boundaries', async () => {
    const priorReflectionJournal = new ReflectionJournalStore(join(tempDir, 'notes', 'reflections', 'journal.jsonl'));
    const priorDailyJournal = new ReflectionDailyJournalStore(join(tempDir, 'notes', 'reflections', 'daily'));
    const priorProcessLog = new ReflectionProcessLogStore(join(tempDir, 'notes', 'reflections', 'process-logs'));
    const priorJournalEntry = priorReflectionJournal.append({
      templateId: 'experiential-review',
      templateName: 'Experiential Review',
      prompt: 'Describe your recent experience.',
      reflection: 'I noticed unresolved ownership questions lingering across the day.',
      channelId: 'internal:reflection:experiential-review',
      mode: 'agent',
      createdAt: '2026-03-01T09:00:00.000Z',
    });
    const priorDailyEntry = priorDailyJournal.append({
      source: 'heartbeat_template',
      executionSource: 'scheduled',
      templateId: 'daily-review',
      templateName: 'Daily Review',
      channelId: 'internal:reflection:daily-review',
      prompt: 'Review the day.',
      reflection: 'The day kept reinforcing steadiness under pressure.',
      mode: 'agent',
      createdAt: '2026-03-01T12:00:00.000Z',
    });
    const priorProcessId = buildReflectionProcessId('Values Reflection Deliberation', () => 1_700_000_000_000);
    const priorProcessEntry = priorProcessLog.append({
      processId: priorProcessId,
      processLabel: 'Values Reflection Deliberation',
      processType: 'reflection_deliberation',
      stage: 'completed',
      executionSource: 'scheduled',
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      channelId: 'internal:reflection:values-reflection',
      prompt: 'Reflect carefully on your current values.',
      reflection: 'Continuity and care remained durable values.',
      createdAt: '2026-03-01T13:00:00.000Z',
      deliberation: {
        sessionId: 'prior-delib-1',
        stopReason: 'stop',
        rounds: 1,
        totalInputTokens: 80,
        totalOutputTokens: 40,
        totalTokens: 120,
        estimatedCostUsd: 0.002,
        durationMs: 400,
      },
    });

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
        content: 'Experiential reflection body with prior-day continuity.',
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

    wireHeartbeatRuntime(
      target,
      scheduler,
      agentLoop,
      sender,
      tempDir,
    );

    const registeredTools = target.registerTool.mock.calls.map(call => call[0]);
    const runTemplateTool = registeredTools.find((tool: { name?: string }) => tool.name === 'heartbeat_run_template');
    expect(runTemplateTool).toBeDefined();

    await runTemplateTool.execute(
      'manual-experiential-substrate',
      { templateId: 'experiential-review', deferIfBusy: false },
      new AbortController().signal,
    );

    const experientialCall = (agentLoop.handleMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.channelId === 'internal:reflection:experiential-review',
    );
    expect(experientialCall?.[0]?.content).toContain('[Reflection Substrate Replay]');
    expect(experientialCall?.[0]?.content).toContain('canonical_truth_boundary: non_canonical_reflection_substrate');
    expect(experientialCall?.[0]?.content).toContain('not canonical truth');
    expect(experientialCall?.[0]?.content).toContain('unresolved ownership questions lingering');
    expect(experientialCall?.[0]?.content).toContain('steadiness under pressure');
    expect(experientialCall?.[0]?.content).toContain('Continuity and care remained durable values');

    const reflectionRaw = readFileSync(join(tempDir, 'notes', 'reflections', 'journal.jsonl'), 'utf-8').trim();
    const reflectionLines = reflectionRaw.split('\n').filter(line => line.trim().length > 0);
    const reflectionEntry = JSON.parse(reflectionLines[reflectionLines.length - 1] ?? '{}') as {
      substrateBoundary?: string;
      substrateProvenanceRefs?: string[];
    };
    expect(reflectionEntry.substrateBoundary).toBe('non_canonical_reflection_substrate');
    expect(reflectionEntry.substrateProvenanceRefs).toEqual(expect.arrayContaining([
      toReflectionJournalProvenanceRef(priorJournalEntry),
      toReflectionDailyJournalProvenanceRef(priorDailyEntry),
      toReflectionProcessLogProvenanceRef(priorProcessEntry),
    ]));
  });

  it('accepts silent heartbeat intervals without persisting or sending outward noise', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const target = {
      registerTool: vi.fn(),
    };
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: '[no reflection]' }),
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
      'heartbeat-channel',
    );

    const registeredTools = target.registerTool.mock.calls.map(call => call[0]);
    const runTemplateTool = registeredTools.find((tool: { name?: string }) => tool.name === 'heartbeat_run_template');
    expect(runTemplateTool).toBeDefined();

    const runResult = await runTemplateTool.execute(
      'manual-silent',
      { templateId: 'whisper', deferIfBusy: false },
      new AbortController().signal,
    );
    const runText = runResult.content.map((part: { text: string }) => part.text).join('');
    expect(runText).toContain('with no note emitted');
    expect(sender.send).not.toHaveBeenCalled();
    expect(existsSync(join(tempDir, 'notes', 'reflections', 'journal.jsonl'))).toBe(false);
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
    const agentLoop = {
      handleMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('Agent is already processing another prompt'))
        .mockResolvedValue({ content: 'Deferred reflection output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
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
      const runTemplateTool = registeredTools.find((tool: { name?: string }) => tool.name === 'heartbeat_run_template');
      expect(runTemplateTool).toBeDefined();

      const runResult = await runTemplateTool.execute(
        'manual-1',
        { templateId: 'whisper' },
        new AbortController().signal,
      );
      const runText = runResult.content.map((part: { text: string }) => part.text).join('');
      expect(runText).toContain('Queued reflection template');

      const deferredTask = scheduler.listTasks().find(task => task.id.startsWith('reflection:deferred:'));
      expect(deferredTask).toBeDefined();

      nowSpy.mockReturnValue((deferredTask?.runAt ?? 0) + 1);
      await scheduler.tick();

      expect(agentLoop.waitForIdle).toHaveBeenCalledOnce();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(2);
      expect(agentLoop.handleMessage.mock.calls[1]?.[0]?.channelId).toBe('internal:reflection:whisper');
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
    const agentLoop = {
      handleMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('Agent is already processing another prompt'))
        .mockResolvedValue({ content: 'Deferred reflection output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      registerPostTurnActionInferer,
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const postTurnActions = {
      registerHandler: vi.fn().mockReturnValue(() => {}),
      listQueued: vi.fn().mockReturnValue([]),
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
        toolName: 'heartbeat_run_template',
        result: {
          details: {
            deferredAction: {
              kind: 'heartbeat.run_template',
              payload: { templateId: 'whisper' },
              dedupeKey: 'heartbeat.run_template:whisper',
              maxRetries: 2,
            },
          },
        },
      }],
    });
    expect(inferredActions).toEqual([{
      kind: 'heartbeat.run_template',
      payload: { templateId: 'whisper' },
      dedupeKey: 'heartbeat.run_template:whisper',
      maxRetries: 2,
    }]);

    const registeredTools = target.registerTool.mock.calls.map(call => call[0]);
    const runTemplateTool = registeredTools.find((tool: { name?: string }) => tool.name === 'heartbeat_run_template');
    expect(runTemplateTool).toBeDefined();

    const runResult = await runTemplateTool.execute(
      'manual-2',
      { templateId: 'whisper' },
      new AbortController().signal,
    );
    const runText = runResult.content.map((part: { text: string }) => part.text).join('');
    expect(runText).toContain('Queued reflection template');
    expect((runResult.details as { deferredAction?: { kind?: string } }).deferredAction?.kind)
      .toBe('heartbeat.run_template');

    const deferredTask = scheduler.listTasks().find(task => task.id.startsWith('reflection:deferred:'));
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
      payload: { templateId: 'whisper' },
      dedupeKey: 'heartbeat.run_template:whisper',
      channelId: 'test-channel',
      sourceMessageId: 'msg-1',
      inferredAt: Date.now(),
    });

    expect(agentLoop.handleMessage).toHaveBeenCalledTimes(2);
    expect(agentLoop.handleMessage.mock.calls[1]?.[0]?.channelId).toBe('internal:reflection:whisper');
  });

  it('gates composed post-turn appraisal by compositional policy', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const duplicateTurnMessages = [{
      role: 'toolResult',
      toolName: 'toolset',
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
      toolName: 'toolset',
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
    const agentLoop = {
      handleMessage: vi.fn().mockResolvedValue({ content: 'Loop candidate reflection output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      registerPostTurnActionInferer: vi.fn().mockReturnValue(() => {}),
    };
    const sender = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const postTurnActions = {
      registerHandler: vi.fn().mockReturnValue(() => {}),
      listQueued: vi.fn().mockReturnValue([]),
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
          payload: { templateId: 'emotional-check' },
          dedupeKey: `heartbeat.run_template:emotional-check:${index}`,
          channelId: 'test-channel',
          sourceMessageId: `msg-loop-${index}`,
          inferredAt: now,
        });
      }

      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(4);
      const handledChannels = agentLoop.handleMessage.mock.calls.map(call => call[0]?.channelId);
      expect(handledChannels).toEqual([
        'internal:reflection:emotional-check',
        'internal:reflection:emotional-check',
        'internal:reflection:emotional-check',
        'internal:reflection:emotional-check',
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('infers deferred tool-handoff actions from late toolset activation payloads', async () => {
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
        toolName: 'toolset',
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
      id: 'msg-toolset-1',
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
        toolName: 'toolset',
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
        id: 'msg-toolset-fail-1',
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
          toolName: 'toolset',
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
    const agentLoop = {
      handleMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('Agent is already processing another prompt'))
        .mockResolvedValue({ content: 'Deferred scheduled output' }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
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

      const whisperTask = scheduler.getTask('reflection:whisper');
      expect(whisperTask).toBeDefined();

      nowSpy.mockReturnValue(1_700_000_000_000 + (whisperTask?.intervalMs ?? 0) + 1);
      await scheduler.tick();

      const deferredTask = scheduler.listTasks().find(task => task.id.startsWith('reflection:deferred:whisper'));
      expect(deferredTask).toBeDefined();

      nowSpy.mockReturnValue((deferredTask?.runAt ?? 0) + 1);
      await scheduler.tick();

      expect(agentLoop.waitForIdle).toHaveBeenCalledOnce();
      expect(agentLoop.handleMessage).toHaveBeenCalledTimes(2);
      expect(agentLoop.handleMessage.mock.calls[1]?.[0]?.channelId).toBe('internal:reflection:whisper');
    } finally {
      nowSpy.mockRestore();
    }
  });
});
