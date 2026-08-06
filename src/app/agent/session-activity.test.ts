import { fromAny } from '@total-typescript/shoehorn';
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
import {
  CAPABILITY_TIER_CHANGE_NOTICE_AUTHOR_ID,
  buildCapabilityTierChange,
  enqueuePendingCapabilityTierChangeNotice,
} from '../../system/capabilities/change-notice.js';

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

    writeStartupSessionMetadata(fromAny(sessionManager), dir, 'reuse_latest_session');
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

    writeStartupSessionMetadata(fromAny(sessionManager), dir, 'reuse_latest_session');
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
      fromAny({
        resolveSessionChannelId: vi.fn(() => 'api:tracked'),
      }),
      dir,
    );

    tracker(fromAny({
      channelId: 'api:tracked',
      channelType: 'api',
      timestamp: new Date(789),
    }));
    await flushLastActiveWrite();

    expect(readLastActiveSession(dir)).toMatchObject({
      sessionId: 'api:tracked',
      channelType: 'api',
      timestamp: 789,
    });
  });

  it('delivers a pending tier change as trusted system context before the turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-activity-tier-change-'));
    tempDirs.push(dir);
    const change = buildCapabilityTierChange(
      { tier: 'autonomous', customTokens: [], grantedTokens: ['identity.read', 'external.web'] },
      { tier: 'nursery', customTokens: [], grantedTokens: ['identity.read'] },
    );
    if (!change) throw new Error('Tier-change fixture must produce a notice');
    enqueuePendingCapabilityTierChangeNotice(dir, change);
    const recordSystemMessage = vi.fn(() => 17);
    const tracker = createSessionActivityTracker(
      {
        resolveSessionChannelId: vi.fn(() => 'api:tracked'),
        recordSystemMessage,
      } as any,
      dir,
    );

    tracker({
      channelId: 'api:tracked',
      channelType: 'api',
      timestamp: new Date(790),
    } as any);

    expect(recordSystemMessage).toHaveBeenCalledWith(
      'api:tracked',
      expect.stringContaining('from "autonomous" to "nursery"'),
      CAPABILITY_TIER_CHANGE_NOTICE_AUTHOR_ID,
      'Capability policy',
    );
  });
});
