import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionActivityTracker,
  writeStartupSessionMetadata,
} from './session-activity.js';
import {
  readLastActiveSession,
  writeLastActiveSession,
} from '../../system/lifecycle/notifications.js';

async function flushLastActiveWrite(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('writeStartupSessionMetadata', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses persisted last-active session metadata without scanning for latest activity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-activity-'));
    tempDirs.push(dir);

    writeLastActiveSession(dir, {
      sessionId: 'api:persisted',
      channelType: 'api',
      timestamp: 123,
    });

    const sessionManager = {
      getMessageCount: vi.fn(() => 4),
      resolveStartupSessionMetadata: vi.fn(() => {
        throw new Error('latest-session scan should not run when persisted metadata is valid');
      }),
    };

    writeStartupSessionMetadata(sessionManager as any, dir, 'reuse_latest_session');
    await flushLastActiveWrite();

    expect(sessionManager.getMessageCount).toHaveBeenCalledWith('api:persisted');
    expect(sessionManager.resolveStartupSessionMetadata).not.toHaveBeenCalled();
    expect(readLastActiveSession(dir)).toMatchObject({
      sessionId: 'api:persisted',
      channelType: 'api',
      timestamp: 123,
    });
  });

  it('falls back to computed startup session metadata when persisted metadata is missing or empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-activity-'));
    tempDirs.push(dir);

    const sessionManager = {
      getMessageCount: vi.fn(() => 0),
      resolveStartupSessionMetadata: vi.fn(() => ({
        sessionId: 'api:computed',
        channelType: 'api',
        timestamp: 456,
      })),
    };

    writeStartupSessionMetadata(sessionManager as any, dir, 'reuse_latest_session');
    await flushLastActiveWrite();

    expect(sessionManager.resolveStartupSessionMetadata).toHaveBeenCalledWith('reuse_latest_session');
    expect(readLastActiveSession(dir)).toMatchObject({
      sessionId: 'api:computed',
      channelType: 'api',
      timestamp: 456,
    });
  });
});

describe('createSessionActivityTracker', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists last-active session data for tracked messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-activity-tracker-'));
    tempDirs.push(dir);

    const tracker = createSessionActivityTracker(
      {
        resolveSessionChannelId: vi.fn(() => 'api:tracked'),
      } as any,
      dir,
    );

    tracker({
      channelId: 'api:tracked',
      channelType: 'api',
      timestamp: new Date(789),
    } as any);
    await flushLastActiveWrite();

    expect(readLastActiveSession(dir)).toMatchObject({
      sessionId: 'api:tracked',
      channelType: 'api',
      timestamp: 789,
    });
  });
});
