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
import { purgeTestingSession } from './testing-session-purge.js';

describe('purgeTestingSession', () => {
  let sessionsDir: string;

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
    const projection = { purgeChannel: vi.fn().mockResolvedValue(undefined) };

    const report = await purgeTestingSession({ sessionsDir, sessionId, projection });

    expect(report).toEqual({
      sessionId,
      channelId: sessionId,
      removedJournalFiles: [filename],
    });
    expect(projection.purgeChannel).toHaveBeenCalledWith(sessionId);
    expect(existsSync(join(sessionsDir, filename))).toBe(false);
    expect(new SessionStore(sessionsDir).listChannels()).toEqual([]);
    const index = JSON.parse(readFileSync(join(sessionsDir, '_channel_index.json'), 'utf8')) as {
      channels: Record<string, unknown>;
    };
    expect(index.channels).toEqual({});
  });

  it('refuses wildcard-like and missing exact targets', async () => {
    const projection = { purgeChannel: vi.fn() };
    await expect(purgeTestingSession({
      sessionsDir,
      sessionId: 'api:testing:*',
      projection,
    })).rejects.toThrow('refuses wildcard-like');
    await expect(purgeTestingSession({
      sessionsDir,
      sessionId: 'api:testing:not-present',
      projection,
    })).rejects.toThrow('not an exact channel-index key');
    expect(projection.purgeChannel).not.toHaveBeenCalled();
  });

  it('refuses non-testing sessions without both force and exact confirmation', async () => {
    const sessionId = 'api:production-conversation';
    const filename = exerciseSession(sessionId);
    const projection = { purgeChannel: vi.fn() };

    await expect(purgeTestingSession({
      sessionsDir,
      sessionId,
      projection,
    })).rejects.toThrow('Refusing to purge non-testing session');
    await expect(purgeTestingSession({
      sessionsDir,
      sessionId,
      projection,
      forceNonTesting: true,
      confirmedNonTestingSessionId: 'api:different-session',
    })).rejects.toThrow('confirmation did not exactly match');

    expect(existsSync(join(sessionsDir, filename))).toBe(true);
    expect(projection.purgeChannel).not.toHaveBeenCalled();
  });

  it('permits a non-testing purge only with force and exact confirmation', async () => {
    const sessionId = 'api:production-conversation';
    exerciseSession(sessionId);
    const projection = { purgeChannel: vi.fn().mockResolvedValue(undefined) };

    await purgeTestingSession({
      sessionsDir,
      sessionId,
      projection,
      forceNonTesting: true,
      confirmedNonTestingSessionId: sessionId,
    });

    expect(new SessionStore(sessionsDir).listChannels()).toEqual([]);
  });

  it('rolls journals and the index back when projection deletion fails', async () => {
    const sessionId = 'api:testing:projection-failure';
    const filename = exerciseSession(sessionId);
    const projection = {
      purgeChannel: vi.fn().mockRejectedValue(new Error('projection unavailable')),
    };

    await expect(purgeTestingSession({
      sessionsDir,
      sessionId,
      projection,
    })).rejects.toThrow('projection unavailable');

    expect(existsSync(join(sessionsDir, filename))).toBe(true);
    expect(new SessionStore(sessionsDir).listChannels()).toEqual([
      { sessionId, channelId: sessionId, messageCount: 1 },
    ]);
  });
});
