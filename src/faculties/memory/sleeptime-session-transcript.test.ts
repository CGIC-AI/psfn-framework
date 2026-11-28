import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../../core/session/manager.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  ClaimedConversationalActivityWorkItem,
  ConversationalActivityWorkItem,
  ConversationalActivityWorksetPort,
} from '../../core/session/conversational-activity-workset.js';
import { SleeptimeMemoryAgent, SLEEPTIME_MEMORY_ACTION_KIND } from './sleeptime-agent.js';

// psfn-framework-5qipi: sleeptime reads each changed session by its stored
// logical id. A `session new|resume` sets the process-wide API active context,
// which must not redirect those reads to the session the companion switched to.

const DM_SESSION = 'api:api-key-0123456789abcdef';
const SPLIT_SESSION = `${DM_SESSION}:soak-dm-1`;
const TESTING_SESSION = `${DM_SESSION}:testing:probe`;

function makeConfig(dataDir: string): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 1000 },
    },
  };
}

/** Sleeptime workset over fixed items; records failures per session. */
function makeWorkset(items: ConversationalActivityWorkItem[]) {
  const failures = new Map<string, string>();
  const done = new Set<string>();
  const find = (sessionId: string) => items.find(item => item.logicalSessionId === sessionId);
  const claimed = (item: ConversationalActivityWorkItem) => (
    { ...item, completedStages: [...item.completedStages] } as ClaimedConversationalActivityWorkItem
  );
  const workset: ConversationalActivityWorksetPort = {
    enumerate: vi.fn(async () => items
      .filter(item => !done.has(item.logicalSessionId))
      .map(item => ({ ...item, completedStages: [...item.completedStages] }))),
    claim: vi.fn(async input => {
      const item = find(input.logicalSessionId);
      if (!item || item.claimantId || input.revision !== item.revision) return null;
      item.claimantId = input.claimantId;
      item.claimedAtMs = 1;
      return claimed(item);
    }),
    resumeClaim: vi.fn(async input => {
      const item = find(input.logicalSessionId);
      return item && item.claimantId === input.claimantId ? claimed(item) : null;
    }),
    checkpointStage: vi.fn(async input => {
      find(input.logicalSessionId)?.completedStages.push(input.stage);
    }),
    recordFailure: vi.fn(async input => {
      failures.set(input.logicalSessionId, input.message);
    }),
    checkpoint: vi.fn(async input => {
      done.add(input.logicalSessionId);
    }),
  };
  return { workset, failures, done };
}

function workItem(logicalSessionId: string, revision: number): ConversationalActivityWorkItem {
  return {
    purpose: 'sleeptime_consolidation',
    logicalSessionId,
    revision,
    activityKind: 'direct_message',
    occurredAtMs: 1,
    checkpointRevision: 0,
    completedStages: [],
  };
}

describe('sleeptime transcript loading through the real session store (5qipi)', () => {
  let dir: string;
  let manager: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-sleeptime-transcript-'));
    manager = new SessionManager(new SessionStore(join(dir, 'sessions')), makeConfig(dir));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function recordConversation(sessionId: string, user: string, assistant: string): number {
    manager.recordUserMessage(sessionId, user, 'user-1', 'User');
    manager.recordAssistantMessage(sessionId, assistant);
    return manager.getMessageCount(sessionId);
  }

  async function runSleeptime(items: ConversationalActivityWorkItem[]) {
    const { workset, failures, done } = makeWorkset(items);
    // The day-transcript loader, observed without replacing it.
    const loader = vi.spyOn(manager, 'getRecentMessagesAtOrBefore');
    // The consolidator and dream pass read through the reader composition
    // wires for them (`storedSessionTranscriptReader`).
    const stageReads: SessionEntry[][] = [];
    const readForStage = async (input: { sessionId: string }) => {
      stageReads.push(manager.storedSessionTranscriptReader.getRecentMessages(input.sessionId, 50));
      return { ran: false };
    };
    const agent = new SleeptimeMemoryAgent({
      agent: {
        handleMessage: vi.fn(async () => ({
          content: JSON.stringify({
            orient: { persona: 'steady', human: 'talkative', goals: 'listen' },
            memory_writes: [],
          }),
        })),
      },
      episodicStore: { searchByTime: vi.fn(async () => []) },
      sessionManager: manager,
      conversationalActivityWorkset: workset,
      coreMemoryStore: {
        getSnapshot: vi.fn().mockReturnValue({
          version: 1,
          updatedAt: '2026-03-01T00:00:00.000Z',
          blocks: {
            persona: { label: 'persona', content: '', maxChars: 2400 },
            human: { label: 'human', content: '', maxChars: 2400, trustLevel: 'trusted' },
            goals: { label: 'goals', content: '', maxChars: 1600 },
          },
        }),
        rethink: vi.fn(),
      },
      resolvedConcernStore: { listRecentlyResolvedConcerns: vi.fn().mockResolvedValue([]) },
      memoryWriter: { write: vi.fn() },
      sleepConsolidator: { run: vi.fn().mockImplementation(readForStage) },
      arcWeaver: { run: vi.fn().mockResolvedValue({ ran: false }) },
      dreamMeaningPass: { run: vi.fn().mockImplementation(readForStage) },
      sleeptimeWikiPass: { run: vi.fn().mockResolvedValue({ ran: false }) },
      restWindow: {
        enabled: true,
        startLocalTime: '00:00',
        endLocalTime: '00:00',
        timeZone: 'UTC',
        inactivityThresholdMinutes: 0,
      },
    });
    const outcome = await agent.execute({
      id: 'sleeptime-action-1',
      sourceMessageId: 'msg-1',
      payload: { kind: SLEEPTIME_MEMORY_ACTION_KIND },
    });
    const loaded = loader.mock.results.map(result => result.value as SessionEntry[]);
    return { outcome, failures, done, loaded, stageReads };
  }

  it.each([
    ['a fresh session with no speech (session new)', false],
    ['another session with speech (session resume)', true],
  ])('reads each changed API session as itself after the active context moves to %s', async (_label, foreignHasSpeech) => {
    const dmRevision = recordConversation(DM_SESSION, 'how was your day?', 'quiet, and yours?');
    const splitRevision = recordConversation(SPLIT_SESSION, 'one more thing', 'tell me');
    const foreignSession = foreignHasSpeech ? `${DM_SESSION}:other-room` : 'api:session-fresh';
    if (foreignHasSpeech) recordConversation(foreignSession, 'foreign words', 'foreign reply');
    manager.setActiveContextSession(foreignSession);
    // Ingress keeps following the switched context.
    expect(manager.resolveSessionForIngress(DM_SESSION)).toBe(foreignSession);

    const { outcome, failures, done, loaded, stageReads } = await runSleeptime([
      workItem(DM_SESSION, dmRevision),
      workItem(SPLIT_SESSION, splitRevision),
    ]);

    expect([...failures.values()]).toEqual([]);
    expect(outcome).toMatchObject({ outcome: 'complete', completedSessions: 2 });
    expect(done).toEqual(new Set([DM_SESSION, SPLIT_SESSION]));
    expect(loaded.map(entries => entries.map(entry => [entry.channelId, entry.role]))).toEqual([
      [[DM_SESSION, 'user'], [DM_SESSION, 'assistant']],
      [[SPLIT_SESSION, 'user'], [SPLIT_SESSION, 'assistant']],
    ]);
    // Two stage reads per session (consolidation, dream pass), all of its own.
    expect(stageReads.map(entries => [...new Set(entries.map(entry => entry.channelId))])).toEqual([
      [DM_SESSION], [DM_SESSION], [SPLIT_SESSION], [SPLIT_SESSION],
    ]);
  });

  it('still leaves testing sessions out of the sleeptime snapshot', async () => {
    const dmRevision = recordConversation(DM_SESSION, 'hello', 'hi');
    const testingRevision = recordConversation(TESTING_SESSION, 'probe', 'probe reply');

    const { outcome, done, loaded } = await runSleeptime([
      workItem(TESTING_SESSION, testingRevision),
      workItem(DM_SESSION, dmRevision),
    ]);

    expect(outcome).toMatchObject({ outcome: 'complete', completedSessions: 1 });
    expect(done).toEqual(new Set([DM_SESSION]));
    expect(loaded.flat().map(entry => entry.channelId)).not.toContain(TESTING_SESSION);
  });
});
