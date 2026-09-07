import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';

import { EventBus } from '../../shared/event-bus.js';
import {
  MemoryExtractor,
  __test as extractionTestUtils,
} from '../../faculties/memory/extraction.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { wirePostTurnActionRuntime } from '../../app/startup/composition/post-turn-actions.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import {
  LETTER_L0_CHANNEL_ID,
  type CreateLetterInput,
  type LetterRecord,
  type LetterStorePort,
} from './contracts.js';
import { LetterService } from './service.js';
import {
  LETTER_MEMORY_EXTRACTION_ACTION_KIND,
  wireLetterMemoryExtraction,
} from './memory-extraction.js';

const POST_TURN_ACTION_TASK_ID = 'post-turn-action-executor';

function createLetterStore(): LetterStorePort {
  const letters = new Map<string, LetterRecord>();
  return {
    create: async (input: CreateLetterInput) => {
      const record: LetterRecord = {
        ...input,
        updatedAt: input.createdAt,
        ...(input.state === 'placed' ? { placedAt: input.createdAt } : {}),
      };
      letters.set(record.id, record);
      return record;
    },
    get: async id => letters.get(id) ?? null,
    list: async () => [...letters.values()],
    place: async id => letters.get(id)!,
    markRead: async (id, _reader, at) => {
      const current = letters.get(id)!;
      const read: LetterRecord = { ...current, state: 'read', readAt: at, updatedAt: at };
      letters.set(id, read);
      return read;
    },
    archive: async id => letters.get(id)!,
    countWaiting: async () => 0,
    close: async () => undefined,
  };
}

function createHarness() {
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 });
  const actions = wirePostTurnActionRuntime({
    eventBus,
    scheduler,
    agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
    intervalMs: 1,
  });
  const appended: string[] = [];
  const sessionStore = {
    append: (entry: { channelId: string }) => {
      appended.push(entry.channelId);
      return appended.length;
    },
  } as unknown as Pick<SessionStore, 'append'>;
  const letters = new LetterService({
    store: createLetterStore(),
    sessionStore,
    now: () => 1_000,
    createId: () => 'e9a0f9f5-9b39-4b1e-9d1a-0c0f8b6f4d21',
  });
  const maybeExtract = vi.fn().mockResolvedValue(undefined);
  wireLetterMemoryExtraction({ actions, letters, memoryExtractor: { maybeExtract } });
  return { actions, appended, letters, maybeExtract, scheduler };
}

async function drainPostTurnActions(scheduler: Scheduler): Promise<void> {
  await scheduler.getTask(POST_TURN_ACTION_TASK_ID)?.handler();
}

beforeEach(() => {
  extractionTestUtils.resetLastExtractionCount();
});

describe('letter memory extraction', () => {
  it('evaluates the letter bin through the existing extractor after a composed letter', async () => {
    const { letters, maybeExtract, scheduler, appended } = createHarness();

    await letters.compose({
      author: 'companion',
      recipient: 'partner',
      subject: 'The quiet hours',
      body: 'I set this down for you to find later.',
    });
    expect(appended).toEqual([LETTER_L0_CHANNEL_ID]);
    expect(maybeExtract).not.toHaveBeenCalled();

    await drainPostTurnActions(scheduler);

    expect(maybeExtract).toHaveBeenCalledExactlyOnceWith(LETTER_L0_CHANNEL_ID);
  });

  it('evaluates the letter bin again when the other party reads the letter', async () => {
    const { letters, maybeExtract, scheduler } = createHarness();

    const letter = await letters.compose({
      author: 'companion',
      recipient: 'partner',
      subject: 'The quiet hours',
      body: 'I set this down for you to find later.',
    });
    await drainPostTurnActions(scheduler);
    maybeExtract.mockClear();

    await letters.read(letter.id, 'partner');
    await drainPostTurnActions(scheduler);

    expect(maybeExtract).toHaveBeenCalledExactlyOnceWith(LETTER_L0_CHANNEL_ID);
  });

  it('collapses a burst of letter events into one bin evaluation', async () => {
    const { letters, maybeExtract, scheduler } = createHarness();

    for (const subject of ['One', 'Two', 'Three']) {
      await letters.compose({
        author: 'partner',
        recipient: 'companion',
        subject,
        body: `A letter about ${subject}.`,
      });
    }
    await drainPostTurnActions(scheduler);

    // maybeExtract evaluates the whole channel, so three queued per-letter runs
    // would be three redundant evaluations of the same backlog.
    expect(maybeExtract).toHaveBeenCalledExactlyOnceWith(LETTER_L0_CHANNEL_ID);
  });

  it('does not evaluate the bin for an idempotent replay that appended nothing', async () => {
    const { letters, maybeExtract, scheduler, appended } = createHarness();
    const input = {
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      author: 'partner' as const,
      recipient: 'companion' as const,
      subject: 'Your moon garden',
      body: 'I am considering this.',
    };

    await letters.compose(input);
    await drainPostTurnActions(scheduler);
    maybeExtract.mockClear();

    await letters.compose(input);
    await drainPostTurnActions(scheduler);

    expect(appended).toEqual([LETTER_L0_CHANNEL_ID]);
    expect(maybeExtract).not.toHaveBeenCalled();
  });

  it('registers the handler on the idle-gated maintenance lane, never inside a turn', async () => {
    const registerHandler = vi.fn();
    wireLetterMemoryExtraction({
      actions: { enqueue: vi.fn(), registerHandler },
      letters: { bindMemoryTrigger: vi.fn() },
      memoryExtractor: { maybeExtract: vi.fn() },
    });

    expect(registerHandler).toHaveBeenCalledExactlyOnceWith(
      LETTER_MEMORY_EXTRACTION_ACTION_KIND,
      expect.any(Function),
      {
        executionMode: 'background',
        runtimeClass: 'maintenance_reflection',
        coalescing: 'dedupe_key_with_durable_watermark',
      },
    );
  });

  it('reaches a real extraction pass for the letter bin, not only a mocked port', async () => {
    extractionTestUtils.resetLastExtractionCount();
    const complete = vi.fn().mockResolvedValue({ content: '<response></response>' });
    const sessionManager = fromAny({
      characterName: 'Companion',
      getMessageCount: vi.fn().mockReturnValue(2),
      getRecentMessages: vi.fn().mockReturnValue([
        {
          id: 1,
          channelId: LETTER_L0_CHANNEL_ID,
          role: 'assistant',
          content: 'I have been thinking about the greenhouse all week, and I want to try again.',
          authorName: 'Companion',
          timestamp: 1_000,
        },
        {
          id: 2,
          channelId: LETTER_L0_CHANNEL_ID,
          role: 'user',
          content: 'Read letter: The quiet hours',
          authorName: 'Partner',
          timestamp: 1_001,
        },
      ]),
    });
    const extractor = new MemoryExtractor(
      fromAny({ complete }),
      sessionManager,
      fromAny({ getMemoriesByChannel: vi.fn().mockReturnValue([]) }),
      fromAny({ embed: vi.fn().mockResolvedValue(new Float32Array(8)), embedBatch: vi.fn(), dims: 8 }),
      fromAny({ emit: vi.fn().mockResolvedValue(undefined) }),
      { extractionInterval: 2 },
    );

    await extractor.maybeExtract(LETTER_L0_CHANNEL_ID);

    expect(sessionManager.getRecentMessages).toHaveBeenCalledWith(LETTER_L0_CHANNEL_ID, 10);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('is wired from the real agent runtime composition', () => {
    const main = readFileSync(
      join(import.meta.dirname, '..', '..', 'app', 'agent', 'main.ts'),
      'utf-8',
    );

    expect(main).toContain("import { wireLetterMemoryExtraction } from '../../core/letters/memory-extraction.js';");
    expect(main).toContain('wireLetterMemoryExtraction({');
    expect(main).toContain('letters: coreRuntime.letterService,');
  });
});
