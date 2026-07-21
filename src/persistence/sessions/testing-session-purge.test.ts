import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from './store.js';
import {
  purgeTestingSession,
  TestingSessionTailPurgeError,
} from './testing-session-purge.js';

describe('purgeTestingSession', () => {
  let sessionsDir: string;

  function databasePurge() {
    return {
      purgeSession: vi.fn().mockResolvedValue({
        removedProjectionRows: 0,
        removedMemoryRows: 0,
        removedContactProfileRows: 0,
        removedMemoryLinkRows: 0,
        removedMaintenanceReviewRows: 0,
      }),
    };
  }

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-testing-session-purge-'));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  function exerciseSession(sessionId: string): string {
    const store = new SessionStore(sessionsDir);
    store.append({
      channelId: sessionId,
      role: 'user',
      content: 'harness exercise',
      timestamp: 1_000,
    });
    const index = JSON.parse(readFileSync(join(sessionsDir, '_channel_index.json'), 'utf8')) as {
      channels: Record<string, { filename: string }>;
    };
    return index.channels[sessionId]!.filename;
  }

  it('purges an exercised testing session from journals, index, and projection', async () => {
    const sessionId = 'api:testing:kube-rollout-validation-20260719';
    const filename = exerciseSession(sessionId);
    const database = databasePurge();

    const report = await purgeTestingSession({ sessionsDir, sessionId, database });

    expect(report).toEqual({
      sessionId,
      channelId: sessionId,
      removedJournalFiles: [filename],
      database: {
        removedProjectionRows: 0,
        removedMemoryRows: 0,
        removedContactProfileRows: 0,
        removedMemoryLinkRows: 0,
        removedMaintenanceReviewRows: 0,
      },
      tailCache: {
        status: 'not_configured',
        message: 'no tail cache configured',
        removedKeys: 0,
      },
    });
    expect(database.purgeSession).toHaveBeenCalledWith({
      sessionId,
      channelId: sessionId,
    });
    expect(existsSync(join(sessionsDir, filename))).toBe(false);
    expect(new SessionStore(sessionsDir).listChannels()).toEqual([]);
    const index = JSON.parse(readFileSync(join(sessionsDir, '_channel_index.json'), 'utf8')) as {
      channels: Record<string, unknown>;
    };
    expect(index.channels).toEqual({});
  });

  it('uses one exact-session database purge contract for projection and durable artifacts', async () => {
    const sessionId = 'api:testing:durable-artifact-purge';
    exerciseSession(sessionId);
    const database = {
      purgeSession: vi.fn().mockResolvedValue({
        removedProjectionRows: 2,
        removedMemoryRows: 1,
        removedContactProfileRows: 1,
        removedMemoryLinkRows: 0,
        removedMaintenanceReviewRows: 0,
      }),
    };

    const report = await purgeTestingSession({
      sessionsDir,
      sessionId,
      database,
    });

    expect(database.purgeSession).toHaveBeenCalledWith({
      sessionId,
      channelId: sessionId,
    });
    expect(report.database).toEqual({
      removedProjectionRows: 2,
      removedMemoryRows: 1,
      removedContactProfileRows: 1,
      removedMemoryLinkRows: 0,
      removedMaintenanceReviewRows: 0,
    });
  });

  it('clears the exact testing-session tail key family in the guarded purge flow', async () => {
    const sessionId = 'api:testing:cached-transcript';
    exerciseSession(sessionId);
    const keys = new Set([
      `psfn:session-tail-epoch:companion:${sessionId}`,
      `psfn:session-tail:companion:${sessionId}:e0`,
      `psfn:session-tail:companion:${sessionId}:e4`,
      'psfn:session-tail:companion:api:testing:other-session:e0',
    ]);
    const tailCache = {
      purgeChannelKeyFamily: vi.fn(async (target: string) => {
        let removed = 0;
        for (const key of [...keys]) {
          if (key.includes(`:${target}:e`) || key.endsWith(`:${target}`)) {
            keys.delete(key);
            removed += 1;
          }
        }
        return removed;
      }),
    };

    const report = await purgeTestingSession({
      sessionsDir,
      sessionId,
      database: databasePurge(),
      tailCache,
    });

    expect(tailCache.purgeChannelKeyFamily).toHaveBeenCalledWith(sessionId);
    expect(report.tailCache).toEqual({
      status: 'purged',
      message: 'purged 3 tail cache keys',
      removedKeys: 3,
    });
    expect(keys).toEqual(new Set([
      'psfn:session-tail:companion:api:testing:other-session:e0',
    ]));
  });

  it('rolls journals and the index back with a named error when configured Redis is unreachable', async () => {
    const sessionId = 'api:testing:redis-unreachable';
    const filename = exerciseSession(sessionId);
    const database = databasePurge();

    await expect(purgeTestingSession({
      sessionsDir,
      sessionId,
      database,
      tailCache: {
        purgeChannelKeyFamily: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      },
    })).rejects.toBeInstanceOf(TestingSessionTailPurgeError);

    expect(existsSync(join(sessionsDir, filename))).toBe(true);
    expect(new SessionStore(sessionsDir).listChannels()).toEqual([
      { sessionId, channelId: sessionId, messageCount: 1 },
    ]);
    expect(database.purgeSession).not.toHaveBeenCalled();
  });

  it('refuses wildcard-like and missing exact targets', async () => {
    const database = databasePurge();
    await expect(purgeTestingSession({
      sessionsDir,
      sessionId: 'api:testing:*',
      database,
    })).rejects.toThrow('refuses wildcard-like');
    await expect(purgeTestingSession({
      sessionsDir,
      sessionId: 'api:testing:not-present',
      database,
    })).rejects.toThrow('not an exact channel-index key');
    expect(database.purgeSession).not.toHaveBeenCalled();
  });

  it('refuses non-testing sessions without both force and exact confirmation', async () => {
    const sessionId = 'api:production-conversation';
    const filename = exerciseSession(sessionId);
    const database = databasePurge();

    await expect(purgeTestingSession({
      sessionsDir,
      sessionId,
      database,
    })).rejects.toThrow('Refusing to purge non-testing session');
    await expect(purgeTestingSession({
      sessionsDir,
      sessionId,
      database,
      forceNonTesting: true,
      confirmedNonTestingSessionId: 'api:different-session',
    })).rejects.toThrow('confirmation did not exactly match');

    expect(existsSync(join(sessionsDir, filename))).toBe(true);
    expect(database.purgeSession).not.toHaveBeenCalled();
  });

  it('permits a non-testing purge only with force and exact confirmation', async () => {
    const sessionId = 'api:production-conversation';
    exerciseSession(sessionId);
    const database = databasePurge();

    await purgeTestingSession({
      sessionsDir,
      sessionId,
      database,
      forceNonTesting: true,
      confirmedNonTestingSessionId: sessionId,
    });

    expect(new SessionStore(sessionsDir).listChannels()).toEqual([]);
  });

  it('rolls journals and the index back when database deletion fails', async () => {
    const sessionId = 'api:testing:projection-failure';
    const filename = exerciseSession(sessionId);
    const database = {
      purgeSession: vi.fn().mockRejectedValue(new Error('database purge unavailable')),
    };

    await expect(purgeTestingSession({
      sessionsDir,
      sessionId,
      database,
    })).rejects.toThrow('database purge unavailable');

    expect(existsSync(join(sessionsDir, filename))).toBe(true);
    expect(new SessionStore(sessionsDir).listChannels()).toEqual([
      { sessionId, channelId: sessionId, messageCount: 1 },
    ]);
  });
});
