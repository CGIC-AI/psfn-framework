import { describe, expect, it, vi } from 'vitest';
import type { AutomataSessionPurgeSurface } from './retention-contract.js';
import {
  EXACT_SESSION_PURGE_SURFACE_ORDER,
  ExactSessionPurgeIncompleteError,
  InMemoryExactSessionPurgeSagaStore,
  ProductionExactSessionPurge,
  type ExactSessionPurgeResolvedTarget,
  type ExactSessionSurfacePurgePort,
} from './production-exact-session-purge.js';
import type { ProtectedSessionOwnership } from './session-classification.js';

const input = {
  companionId: 'companion-a',
  sessionId: 'session-a',
  runId: 'run-a',
  targetRevision: 'revision-a',
  preserveReferences: ['bus:receipt:1', 'artifact:commit:abc'],
};

const automataTarget: ExactSessionPurgeResolvedTarget = {
  classification: {
    schemaVersion: 1,
    companionId: 'companion-a',
    sessionId: 'session-a',
    ownership: 'automata',
    runId: 'run-a',
    automatonClass: 'subagent.bounded',
    workerGeneration: 2,
    classifiedAtMs: 1,
    retentionDeadlineMs: 2,
  },
  channelId: 'worker:session-a',
  tailChannelKey: 'session-a',
  turnRecordChannelId: 'worker:session-a',
  activeJournalFilename: 'worker-session-a.jsonl',
  rolledJournalFilenames: [
    'worker-session-a.00001.jsonl',
    'worker-session-a.00002.jsonl',
  ],
};

class FakeSurface implements ExactSessionSurfacePurgePort {
  present = true;
  failAfterDelete = false;
  removeCalls = 0;
  verifyCalls = 0;

  async remove() {
    this.removeCalls += 1;
    const wasPresent = this.present;
    this.present = false;
    if (this.failAfterDelete) {
      this.failAfterDelete = false;
      throw new Error('injected crash after irreversible delete');
    }
    return wasPresent
      ? { status: 'removed' as const, removedCount: 1 }
      : { status: 'already_absent' as const, removedCount: 0 };
  }

  async isAbsent() {
    this.verifyCalls += 1;
    return !this.present;
  }
}

function harness(options: {
  store?: InMemoryExactSessionPurgeSagaStore;
  target?: ExactSessionPurgeResolvedTarget;
  surfaces?: Record<AutomataSessionPurgeSurface, FakeSurface>;
} = {}) {
  const sagaStore = options.store ?? new InMemoryExactSessionPurgeSagaStore();
  const target = options.target ?? automataTarget;
  const surfaces = options.surfaces ?? Object.fromEntries(
    EXACT_SESSION_PURGE_SURFACE_ORDER.map(surface => [surface, new FakeSurface()]),
  ) as Record<AutomataSessionPurgeSurface, FakeSurface>;
  const resolveAndAuthorize = vi.fn(async () => target);
  const revalidate = vi.fn(async () => undefined);
  const assertResolvable = vi.fn(async () => undefined);
  const runExclusive = vi.fn(async <T>(_input: unknown, operation: () => Promise<T>) => (
    await operation()
  ));
  return {
    sagaStore,
    surfaces,
    resolveAndAuthorize,
    revalidate,
    assertResolvable,
    purge: new ProductionExactSessionPurge({
      authority: { resolveAndAuthorize, revalidate },
      custody: { assertResolvable },
      fence: { runExclusive },
      sagaStore,
      surfaces,
    }),
  };
}

describe('ProductionExactSessionPurge', () => {
  it('records pending/completed around every surface and succeeds only after final absence', async () => {
    const test = harness();
    await expect(test.purge.purgeExactSession(input)).resolves.toEqual({
      companionId: 'companion-a',
      sessionId: 'session-a',
      runId: 'run-a',
      targetRevision: 'revision-a',
      status: 'purged',
      surfaces: EXACT_SESSION_PURGE_SURFACE_ORDER.map(surface => ({
        surface,
        status: 'removed',
        removedCount: 1,
      })),
      verifiedPreservedReferences: ['artifact:commit:abc', 'bus:receipt:1'],
    });
    const saga = await test.sagaStore.load('companion-a', 'session-a');
    expect(saga).toMatchObject({ status: 'completed' });
    expect(Object.values(saga!.surfaces)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'completed', attempts: 1 }),
    ]));
    expect(test.revalidate).toHaveBeenCalledTimes(EXACT_SESSION_PURGE_SURFACE_ORDER.length + 2);
    expect(test.assertResolvable).toHaveBeenCalledTimes(2);
  });

  it.each(EXACT_SESSION_PURGE_SURFACE_ORDER)(
    'recovers after a process dies immediately after deleting %s',
    async (failedSurface) => {
      const first = harness();
      first.surfaces[failedSurface].failAfterDelete = true;
      await expect(first.purge.purgeExactSession(input)).rejects.toBeInstanceOf(
        ExactSessionPurgeIncompleteError,
      );

      const partial = await first.sagaStore.load('companion-a', 'session-a');
      expect(partial?.status).toBe('in_progress');
      expect(partial?.surfaces[failedSurface]).toMatchObject({
        status: 'pending',
        attempts: 1,
        removedCount: 0,
      });
      expect(partial?.surfaces[failedSurface].lastErrorDigest).toMatch(/^[0-9a-f]{64}$/u);
      for (const surface of EXACT_SESSION_PURGE_SURFACE_ORDER) {
        const state = partial!.surfaces[surface];
        const relative = EXACT_SESSION_PURGE_SURFACE_ORDER.indexOf(surface)
          - EXACT_SESSION_PURGE_SURFACE_ORDER.indexOf(failedSurface);
        if (relative < 0) expect(state.status).toBe('completed');
        if (relative > 0) expect(state.status).toBe('not_started');
      }

      const restarted = harness({
        store: first.sagaStore,
        surfaces: first.surfaces,
      });
      await expect(restarted.purge.purgeExactSession(input)).resolves.toMatchObject({
        status: 'purged',
        surfaces: expect.arrayContaining([
          expect.objectContaining({
            surface: failedSurface,
            status: 'already_absent',
            removedCount: 0,
          }),
        ]),
      });
      expect(first.surfaces[failedSurface].removeCalls).toBe(2);
    },
  );

  it('returns already_purged only after re-verifying every surface and permanent ref', async () => {
    const first = harness();
    await first.purge.purgeExactSession(input);
    const restarted = harness({ store: first.sagaStore, surfaces: first.surfaces });
    await expect(restarted.purge.purgeExactSession(input)).resolves.toMatchObject({
      status: 'already_purged',
    });
    expect(Object.values(restarted.surfaces).every(surface => surface.verifyCalls > 1)).toBe(true);
    expect(restarted.assertResolvable).toHaveBeenCalledTimes(2);
  });

  it.each<ProtectedSessionOwnership>(['unknown', 'companion', 'free_time', 'icp', 'contact'])(
    'rejects protected %s classification before creating a saga',
    async (ownership) => {
      const target: ExactSessionPurgeResolvedTarget = {
        ...automataTarget,
        classification: {
          schemaVersion: 1,
          companionId: 'companion-a',
          sessionId: 'session-a',
          ownership,
          classifiedAtMs: 1,
        },
      };
      const test = harness({ target });
      await expect(test.purge.purgeExactSession(input)).rejects.toThrow(
        `refuses protected ${ownership} session`,
      );
      expect(await test.sagaStore.load('companion-a', 'session-a')).toBeNull();
      expect(Object.values(test.surfaces).every(surface => surface.removeCalls === 0)).toBe(true);
    },
  );

  it('rejects a cross-companion target before creating a saga', async () => {
    const target: ExactSessionPurgeResolvedTarget = {
      ...automataTarget,
      classification: {
        ...automataTarget.classification,
        companionId: 'companion-b',
      },
    };
    const test = harness({ target });
    await expect(test.purge.purgeExactSession(input)).rejects.toThrow(
      'classification does not match',
    );
    expect(await test.sagaStore.load('companion-a', 'session-a')).toBeNull();
  });

  it('does not write a success receipt when a final verifier sees resurrected data', async () => {
    const test = harness();
    const tail = test.surfaces.redis_tail_pointers;
    let verifies = 0;
    tail.isAbsent = vi.fn(async () => {
      verifies += 1;
      return verifies < 2;
    });
    await expect(test.purge.purgeExactSession(input)).rejects.toBeInstanceOf(
      ExactSessionPurgeIncompleteError,
    );
    expect((await test.sagaStore.load('companion-a', 'session-a'))?.status).toBe('in_progress');
  });
});
