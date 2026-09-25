import { fromAny } from '@total-typescript/shoehorn';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionOutcome } from '../../../primitives/llm/decision/types.js';
import { MemoryExtractor } from '../extraction.js';

function nothingToRemember(pYes: number): DecisionOutcome {
  return {
    ok: true,
    answers: { nothing_to_do: { type: 'noul', pYes } },
    backend: 'jev',
    probabilitySource: 'jev',
    latencyMs: 20,
  };
}

function rig(channelId: string, options: {
  threshold: number | null;
  pNothing: number;
  messageCount?: number;
}) {
  const llmClient = fromAny({ complete: vi.fn().mockResolvedValue({ content: '<response></response>' }) });
  const decide = vi.fn(async () => nothingToRemember(options.pNothing));
  const sessionManager = fromAny({
    getMessageCount: vi.fn().mockReturnValue(options.messageCount ?? 5),
    getRecentMessages: vi.fn().mockReturnValue([
      { id: 1, channelId, role: 'user', content: 'hey, how was your day?', authorName: 'user', timestamp: 1_000 },
      { id: 2, channelId, role: 'assistant', content: 'good, thanks!', authorName: 'c', timestamp: 1_001 },
    ]),
  });
  const eventBus = fromAny({ emit: vi.fn().mockResolvedValue(undefined) });
  const started = (): boolean => (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
    .some(([name]) => name === 'memory.extraction.start');
  const extractor = new MemoryExtractor(
    llmClient,
    sessionManager,
    fromAny({ getMemoriesByChannel: vi.fn().mockReturnValue([]) }),
    fromAny({ embed: vi.fn().mockResolvedValue(new Float32Array(8)), embedBatch: vi.fn(), dims: 8 }),
    eventBus,
    { extractionInterval: 5 },
    null,
    null,
    null,
    {
      decisions: {
        decide,
        siteSettings: () => (options.threshold === null ? undefined : { enabled: true, threshold: options.threshold }),
      },
    },
  );
  return { extractor, llmClient, decide, started };
}

describe('memory extraction pre-gate', () => {
  it('skips the interval extraction when nothing-to-remember clears the threshold', async () => {
    const { extractor, llmClient, decide, started } = rig('api:pregate-skip', { threshold: 0.8, pNothing: 0.9 });
    await extractor.maybeExtract('api:pregate-skip');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0]).toMatchObject({
      siteId: 'memory.extraction_pregate',
      state: { messages: [
        { role: 'user', text: 'hey, how was your day?' },
        { role: 'assistant', text: 'good, thanks!' },
      ] },
    });
    expect(llmClient.complete).not.toHaveBeenCalled();
    expect(started()).toBe(false);
  });

  it('runs the extraction below the threshold', async () => {
    const { extractor, started } = rig('api:pregate-run', { threshold: 0.8, pNothing: 0.5 });
    await extractor.maybeExtract('api:pregate-run');
    expect(started()).toBe(true);
  });

  it('is inert (no decision) when the pre-gate site is not enabled', async () => {
    const { extractor, decide, started } = rig('api:pregate-off', { threshold: null, pNothing: 1 });
    await extractor.maybeExtract('api:pregate-off');
    expect(decide).not.toHaveBeenCalled();
    expect(started()).toBe(true);
  });

  it('gates an interval-triggered durable post-turn snapshot over its uncovered entries', async () => {
    const channelId = 'api:pregate-snapshot';
    const snapshotEntries = Array.from({ length: 5 }, (_value, index) => ({
      id: index + 1,
      channelId,
      role: 'user' as const,
      content: `message ${index}`,
      timestamp: 1_000 + index,
    }));
    const snapshot = rig(channelId, { threshold: 0.8, pNothing: 0.95 });
    await snapshot.extractor.maybeExtract(
      channelId, undefined, undefined, undefined, undefined, undefined, snapshotEntries,
    );
    expect(snapshot.decide).toHaveBeenCalledTimes(1);
    expect(snapshot.decide.mock.calls[0]?.[0]).toMatchObject({
      siteId: 'memory.extraction_pregate',
      state: { messages: snapshotEntries.map(entry => ({ role: 'user', text: entry.content })) },
    });
    expect(snapshot.llmClient.complete).not.toHaveBeenCalled();
    expect(snapshot.started()).toBe(false);

    // The skipped interval is consumed: the same snapshot no longer triggers.
    await snapshot.extractor.maybeExtract(
      channelId, undefined, undefined, undefined, undefined, undefined, snapshotEntries,
    );
    expect(snapshot.decide).toHaveBeenCalledTimes(1);
    expect(snapshot.started()).toBe(false);
  });

  it('runs a durable snapshot extraction when the pre-gate does not clear the threshold', async () => {
    const channelId = 'api:pregate-snapshot-run';
    const snapshot = rig(channelId, { threshold: 0.8, pNothing: 0.2 });
    await snapshot.extractor.maybeExtract(
      channelId, undefined, undefined, undefined, undefined, undefined,
      Array.from({ length: 5 }, (_value, index) => ({
        id: index + 1,
        channelId,
        role: 'user' as const,
        content: `message ${index}`,
        timestamp: 1_000 + index,
      })),
    );
    expect(snapshot.decide).toHaveBeenCalledTimes(1);
    expect(snapshot.started()).toBe(true);
  });

  it('never gates a manual extraction', async () => {
    const manual = rig('api:pregate-manual', { threshold: 0.1, pNothing: 1 });
    await manual.extractor.extract('api:pregate-manual');
    expect(manual.decide).not.toHaveBeenCalled();
    expect(manual.started()).toBe(true);
  });
});
