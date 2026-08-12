import { describe, expect, it } from 'vitest';
import { InMemoryAutomataRetentionStore } from './retention-store.js';
import {
  AutomataSessionClassificationService,
  classifySessionAtCreation,
  resolveForegroundSessionOwner,
} from './session-classification.js';

const ownerPolicy = { rawSessionRetentionMs: 202 };

describe('classifySessionAtCreation', () => {
  it('derives the automata deadline only from the owner policy', () => {
    expect(classifySessionAtCreation({
      companionId: 'companion-a',
      sessionId: 'worker-session',
      createdAtMs: 1_000,
      owner: {
        kind: 'automata',
        runId: 'run-a',
        automatonClass: 'subagent.bounded',
        workerGeneration: 2,
      },
    }, ownerPolicy)).toEqual({
      schemaVersion: 1,
      companionId: 'companion-a',
      sessionId: 'worker-session',
      ownership: 'automata',
      runId: 'run-a',
      automatonClass: 'subagent.bounded',
      workerGeneration: 2,
      classifiedAtMs: 1_000,
      retentionDeadlineMs: 1_202,
    });
  });

  it.each([
    [undefined, 'unknown'],
    [{ kind: 'companion' as const }, 'companion'],
    [{ kind: 'icp' as const }, 'icp'],
    [{ kind: 'contact' as const }, 'contact'],
  ])('permanently protects missing and companion-owned provenance', (owner, ownership) => {
    expect(classifySessionAtCreation({
      companionId: 'companion-a',
      sessionId: `session-${ownership}`,
      createdAtMs: 1,
      ...(owner ? { owner } : {}),
    }, ownerPolicy)).toMatchObject({ ownership });
  });

  it('protects free-time even if a caller presents the registered scheduler as automata', () => {
    expect(classifySessionAtCreation({
      companionId: 'companion-a',
      sessionId: 'free-time-session',
      createdAtMs: 1,
      owner: {
        kind: 'automata',
        runId: 'free-time-run',
        automatonClass: 'scheduler.free_time',
        workerGeneration: 1,
      },
    }, ownerPolicy)).toMatchObject({ ownership: 'free_time' });
  });

  it('rejects unknown automata classes instead of guessing ownership', () => {
    expect(() => classifySessionAtCreation({
      companionId: 'companion-a',
      sessionId: 'mystery-worker',
      createdAtMs: 1,
      owner: {
        kind: 'automata',
        runId: 'run-a',
        automatonClass: 'future.worker',
        workerGeneration: 1,
      },
    }, ownerPolicy)).toThrow('Unknown automata class');
  });

  it('persists classification as part of the creation boundary', async () => {
    const store = new InMemoryAutomataRetentionStore();
    const service = new AutomataSessionClassificationService(ownerPolicy, store);
    await service.classifyAtCreation({
      companionId: 'companion-a',
      sessionId: 'worker-session',
      createdAtMs: 1_000,
      owner: {
        kind: 'automata',
        runId: 'run-a',
        automatonClass: 'subagent.bounded',
        workerGeneration: 1,
      },
    });
    expect(store.listClassifications()).toHaveLength(1);
  });

  it('persists missing foreground authority as immutable unknown before reuse', async () => {
    const store = new InMemoryAutomataRetentionStore();
    const service = new AutomataSessionClassificationService(ownerPolicy, store);
    const first = await service.ensureClassifiedAtCreation({
      companionId: 'companion-a',
      sessionId: 'discord:unbound',
      createdAtMs: 1_000,
      owner: resolveForegroundSessionOwner({
        channelId: 'discord:unbound',
        channelType: 'discord',
        hasIcpCorrelation: false,
      }),
    });
    const reused = await service.ensureClassifiedAtCreation({
      companionId: 'companion-a',
      sessionId: 'discord:unbound',
      createdAtMs: 2_000,
      owner: { kind: 'contact' },
    });
    expect(first).toMatchObject({ ownership: 'unknown', classifiedAtMs: 1_000 });
    expect(reused).toEqual(first);
    expect(store.listClassifications()).toEqual([first]);
  });

  it.each([
    [{ channelId: 'internal:free-time:project', channelType: 'api', hasIcpCorrelation: false }, 'free_time'],
    [{ channelId: 'companion:peer', channelType: 'companion', hasIcpCorrelation: true }, 'icp'],
    [{ channelId: 'discord:dm', channelType: 'discord', hasIcpCorrelation: false, canonicalContactId: 'contact-a' }, 'contact'],
    [{ channelId: 'companion:self', channelType: 'companion', hasIcpCorrelation: false }, 'companion'],
  ])('recognizes explicit foreground ownership %#', (input, ownership) => {
    expect(resolveForegroundSessionOwner(input)).toEqual({ kind: ownership });
  });

  it('has no implicit retention fallback when owner policy is invalid', () => {
    expect(() => classifySessionAtCreation({
      companionId: 'companion-a',
      sessionId: 'worker-session',
      createdAtMs: 1_000,
      owner: {
        kind: 'automata',
        runId: 'run-a',
        automatonClass: 'subagent.bounded',
        workerGeneration: 1,
      },
    }, { rawSessionRetentionMs: 0 })).toThrow('rawSessionRetentionMs');
  });
});
