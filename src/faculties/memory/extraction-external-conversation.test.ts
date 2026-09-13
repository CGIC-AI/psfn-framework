import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionEntry } from '../../core/session/types.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import {
  MemoryExtractor,
  __test as extractionTestUtils,
  type MemoryExtractorFormationOptions,
} from './extraction.js';
import { createAutomatedConcernRuntime } from '../../core/intention/concern-candidates.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';
import { EventBus } from '../../shared/event-bus.js';
import { ExtractionDrainRequeueError } from './extraction/drain-signal.js';
import { RECOVERY_CONTEXT_MESSAGE_LIMIT } from './extraction/types.js';

const sessionId = 'api:hermes:body-fixture:conversation-fixture';
const canonicalContactId = 'contact-operator-fixture';
const emptyResponse = { content: '<response></response>' };
const tempDirs: string[] = [];

afterEach(() => {
  extractionTestUtils.resetLastExtractionCount();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeHarness(
  externalSessionId = sessionId,
  formationOptions?: MemoryExtractorFormationOptions,
) {
  const sessionId = externalSessionId;
  const directory = mkdtempSync(join(tmpdir(), 'psfn-external-extraction-'));
  tempDirs.push(directory);
  const sessionStore = new SessionStore(directory);
  const recordMarker = vi.spyOn(sessionStore, 'insertExtractionMarker');
  const llmClient = { complete: vi.fn().mockResolvedValue(emptyResponse) };
  const sessionManager = {
    characterName: 'Lyra',
    resolveSessionChannelId: vi.fn().mockReturnValue('discord:unrelated-active-context'),
    isSessionRetiredOrQuarantined: vi.fn().mockReturnValue(false),
    getRecentMessages: vi.fn(() => { throw new Error('External extraction must not read mutable history'); }),
    getMessageCount: vi.fn(() => { throw new Error('External extraction must not count mutable history'); }),
    intakeSinkGate: null,
  };
  const memoryStore = { getMemoriesByChannel: vi.fn().mockResolvedValue([]) };
  const eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
  const extractor = new MemoryExtractor(
    fromAny(llmClient),
    fromAny(sessionManager),
    fromAny(memoryStore),
    fromAny({ embed: vi.fn(), embedBatch: vi.fn(), dims: 8 }),
    fromAny(eventBus),
    { extractionInterval: 10 },
    null,
    sessionStore,
    null,
    formationOptions,
  );
  const write = vi.fn().mockResolvedValue({ action: 'created', memory: { id: 'memory-fixture' } });
  fromAny(extractor).writer = { write };
  const appendPair = (topic = 'the cedar garden project'): SessionEntry[] => {
    for (const role of ['user', 'assistant'] as const) {
      sessionStore.append({
        channelId: sessionId,
        role,
        authorId: role === 'user' ? canonicalContactId : 'companion-fixture',
        authorName: role === 'user' ? 'Alex' : 'Lyra',
        content: role === 'user' ? `I plan to work on ${topic} tomorrow.` : `We will revisit ${topic} tomorrow.`,
        timestamp: Date.now(),
        channelVisibility: 'private',
        metadata: JSON.stringify({
          conversationOrigin: { schemaVersion: 1, kind: 'direct_message' },
          externalOrigin: { runtime: 'hermes', bodyId: 'body-fixture', sessionId: 'conversation-fixture' },
        }),
      });
    }
    return sessionStore.getRecent(sessionId, 2);
  };
  const extract = (entries: readonly SessionEntry[]) => extractor.extractExternalConversation({
    sessionId,
    canonicalContactId,
    entries,
  });
  return { extractor, extract, appendPair, recordMarker, llmClient, sessionManager, memoryStore, eventBus, write };
}

describe('external conversation extraction', () => {
  it('completes external extraction after persisting a concern with full source evidence', async () => {
    const { ports } = createTestPostgresIntentionPorts();
    const runtime = await createAutomatedConcernRuntime({
      eventBus: new EventBus(),
      llmProvider: fromAny({ complete: vi.fn() }),
      concernStore: ports.concernStore,
    });
    const externalSessionId = `api:hermes:${'b'.repeat(64)}`;
    const harness = makeHarness(externalSessionId, { emitConcernCandidates: runtime.extractionSink });
    harness.llmClient.complete.mockResolvedValue({ content: `<response><fact>
<text>Alex plans to work on the cedar garden project tomorrow.</text>
<type>semantic</type><importance>0.9</importance><confidence>0.95</confidence>
</fact></response>` });
    try {
      const outputs = await harness.extract(harness.appendPair());
      expect(outputs.memoryIds).toEqual(['memory-fixture']);
      expect(outputs.concernIds).toHaveLength(1);
      const concern = await ports.concernStore.getById(outputs.concernIds[0]!);
      expect(concern?.candidateReviewSnapshot).toMatchObject({
        channelId: externalSessionId,
        triggerReason: 'external_conversation',
        sourceRef: harness.write.mock.calls[0]![0].sourceRef,
      });
    } finally {
      runtime.dispose();
    }
  });

  it('extracts a short pair in its immutable session and preserves external source evidence', async () => {
    const harness = makeHarness();
    const entries = harness.appendPair();
    harness.llmClient.complete.mockResolvedValue({ content: `<response><fact>
<text>Alex plans to work on the cedar garden project tomorrow.</text>
<type>semantic</type><importance>0.9</importance><confidence>0.95</confidence>
</fact></response>` });

    await expect(harness.extract(entries)).resolves.toMatchObject({ memoryIds: ['memory-fixture'] });

    expect(harness.llmClient.complete).toHaveBeenCalledTimes(1);
    expect(harness.sessionManager.resolveSessionChannelId).not.toHaveBeenCalled();
    expect(harness.sessionManager.getRecentMessages).not.toHaveBeenCalled();
    expect(harness.sessionManager.getMessageCount).not.toHaveBeenCalled();
    expect(harness.memoryStore.getMemoriesByChannel).toHaveBeenCalledWith(sessionId, 30);
    expect(harness.write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: expect.stringContaining(sessionId),
      provenance: expect.objectContaining({
        channelId: sessionId,
        sessionId,
        reason: 'external_conversation',
      }),
    }));
    expect(harness.recordMarker).toHaveBeenCalledWith(sessionId, entries.at(-1)!.id);
    expect(harness.eventBus.emit).toHaveBeenCalledWith('memory.extraction.start', expect.objectContaining({
      channelId: sessionId,
      triggerReason: 'external_conversation',
    }));
  });

  it('serializes each exact snapshot behind existing work instead of coalescing it away', async () => {
    const harness = makeHarness();
    const firstEntries = harness.appendPair('the first project');
    const secondEntries = harness.appendPair('the second project');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    harness.llmClient.complete.mockImplementationOnce(async () => { await pending; return emptyResponse; });
    const first = harness.extract(firstEntries);
    await vi.waitFor(() => expect(harness.llmClient.complete).toHaveBeenCalledTimes(1));
    const second = harness.extract(secondEntries);
    secondEntries[0]!.content = 'Mutation after admission must not replace the snapshot.';
    await Promise.resolve();
    expect(harness.llmClient.complete).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);

    expect(harness.llmClient.complete).toHaveBeenCalledTimes(2);
    const secondPrompt = harness.llmClient.complete.mock.calls[1]![0].systemPrompt;
    expect(secondPrompt).toContain('the second project');
    expect(secondPrompt).not.toContain('the first project');
    expect(secondPrompt).not.toContain('Mutation after admission');
    expect(harness.recordMarker.mock.calls.map(call => call.slice(0, 2))).toEqual([
      [sessionId, firstEntries.at(-1)!.id],
      [sessionId, secondEntries.at(-1)!.id],
    ]);
  });

  it('rejects both in-flight and queued work on drain without recording coverage', async () => {
    const harness = makeHarness();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    harness.llmClient.complete.mockImplementationOnce(async () => { await pending; return emptyResponse; });
    const first = harness.extract(harness.appendPair('the first project'));
    await vi.waitFor(() => expect(harness.llmClient.complete).toHaveBeenCalledTimes(1));
    const second = harness.extract(harness.appendPair('the second project'));
    const results = Promise.allSettled([first, second]);
    const stopping = harness.extractor.stop();
    release();
    expect(await results).toEqual([
      { status: 'rejected', reason: expect.any(ExtractionDrainRequeueError) },
      { status: 'rejected', reason: expect.any(ExtractionDrainRequeueError) },
    ]);
    await expect(stopping).resolves.toBe(true);
    expect(harness.llmClient.complete).toHaveBeenCalledTimes(1);
    expect(harness.recordMarker).not.toHaveBeenCalled();
  });

  it('leaves failed model work retryable against the same snapshot', async () => {
    const harness = makeHarness();
    const entries = harness.appendPair();
    harness.llmClient.complete.mockRejectedValueOnce(new Error('model unavailable'));
    await expect(harness.extract(entries)).rejects.toThrow('Extraction orchestration failed');
    expect(harness.recordMarker).not.toHaveBeenCalled();
    await expect(harness.extract(entries)).resolves.toEqual({ memoryIds: [], concernIds: [], contactIds: [] });
    expect(harness.llmClient.complete).toHaveBeenCalledTimes(2);
    expect(harness.recordMarker).toHaveBeenCalledOnce();
  });

  it('propagates marker persistence failure instead of acknowledging coverage', async () => {
    const harness = makeHarness();
    const entries = harness.appendPair();
    harness.recordMarker.mockImplementationOnce(() => { throw new Error('archive unavailable'); });
    await expect(harness.extract(entries)).rejects.toThrow('archive unavailable');
    await expect(harness.extract(entries)).resolves.toEqual({ memoryIds: [], concernIds: [], contactIds: [] });
    expect(harness.llmClient.complete).toHaveBeenCalledTimes(2);
  });

  it.each(['before admission', 'during extraction'])('rejects retired or quarantined sessions %s', async timing => {
    const harness = makeHarness();
    const entries = harness.appendPair();
    if (timing === 'before admission') {
      harness.sessionManager.isSessionRetiredOrQuarantined.mockReturnValue(true);
    } else {
      harness.llmClient.complete.mockImplementationOnce(async () => {
        harness.sessionManager.isSessionRetiredOrQuarantined.mockReturnValue(true);
        return emptyResponse;
      });
    }
    await expect(harness.extract(entries)).rejects.toThrow('retired or quarantined');
    expect(harness.recordMarker).not.toHaveBeenCalled();
    expect(harness.write).not.toHaveBeenCalled();
  });

  it('preserves the intake memory-write gate over the supplied source metadata', async () => {
    const harness = makeHarness();
    const entries = harness.appendPair();
    const envelope = {
      envelopeId: 'external-envelope-fixture', sourceClass: 'regular_contact',
      sourceRiskTier: 'standard', state: 'screened', riskLabels: [], subject: { kind: 'body' },
    };
    entries[0]!.metadata = JSON.stringify({ intakeScreening: {
      schemaVersion: 1, mode: 'enforce', withheld: false, envelopes: [envelope],
    } });
    const evaluate = vi.fn().mockReturnValue({
      sink: 'memory_write', allowed: false, verdict: 'deny', mode: 'enforce',
      reason: 'blocked_source', unscreened: false, deniedEnvelopeIds: [envelope.envelopeId],
    });
    fromAny(harness.sessionManager).intakeSinkGate = { mode: 'enforce', evaluate };
    harness.llmClient.complete.mockResolvedValue({ content: `<response><fact>
<text>Alex plans to work on the cedar garden project tomorrow.</text>
<type>semantic</type><importance>0.9</importance><confidence>0.95</confidence>
</fact></response>` });

    await expect(harness.extract(entries)).resolves.toMatchObject({ memoryIds: [] });
    expect(evaluate).toHaveBeenCalledWith('memory_write', [expect.objectContaining(envelope)], expect.anything(), expect.anything());
    expect(harness.write).not.toHaveBeenCalled();
  });

  it('rejects foreign entries and oversized ranges before the recovery tail could truncate them', async () => {
    const harness = makeHarness();
    const entries = harness.appendPair();
    await expect(harness.extract([{ ...entries[0]!, channelId: 'api:foreign' }])).rejects.toThrow('exact session');
    const oversized = Array.from({ length: RECOVERY_CONTEXT_MESSAGE_LIMIT + 1 }, (_, index) => ({
      ...entries[0]!, id: index + 1,
    }));
    await expect(harness.extract(oversized)).rejects.toThrow('bounded');
    expect(harness.llmClient.complete).not.toHaveBeenCalled();
    expect(harness.recordMarker).not.toHaveBeenCalled();
  });
});
