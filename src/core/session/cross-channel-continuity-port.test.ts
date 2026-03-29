import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { UserContinuityStore } from './continuity.js';
import {
  createNullCrossChannelContinuityPort,
  createUserContinuityPort,
} from './cross-channel-continuity-port.js';

describe('createUserContinuityPort', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends, merges, and parses continuity provenance through the port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-cross-continuity-'));
    dirs.push(dir);
    const store = new UserContinuityStore(dir);
    const continuity = createUserContinuityPort(store);

    continuity.append({
      continuityUserId: 'contact-1',
      entry: {
        channelId: 'api:private-main',
        role: 'user',
        content: 'Private continuity note',
        authorId: 'contact-1',
        authorName: 'Alice',
        timestamp: Date.now(),
        originChannelId: 'api:private-main',
        channelVisibility: 'private',
      },
    });
    continuity.append({
      continuityUserId: 'legacy-discord-1',
      entry: {
        channelId: '1234567890',
        role: 'assistant',
        content: 'Fallback continuity note',
        timestamp: Date.now() + 1,
        originChannelId: '1234567890',
        channelVisibility: 'semi_private',
      },
    });

    const merged = continuity.getMerged({
      canonicalUserId: 'contact-1',
      fallbackUserIds: ['legacy-discord-1'],
      limit: 10,
      channelId: 'api:private-main',
    });

    expect(merged.map(entry => entry.content)).toEqual(['Fallback continuity note']);
    expect(continuity.parseProvenance(merged[0]?.metadata)).toEqual(expect.objectContaining({
      kind: 'continuity',
      continuityUserId: 'legacy-discord-1',
      sourceChannelId: '1234567890',
    }));
  });

  it('fails closed to empty results when no continuity store is wired', () => {
    const continuity = createNullCrossChannelContinuityPort();

    expect(continuity.append({
      continuityUserId: 'contact-1',
      entry: {
        channelId: 'api:private-main',
        role: 'user',
        content: 'no-op',
        authorId: 'contact-1',
        authorName: 'Alice',
        timestamp: Date.now(),
      },
    })).toBeNull();
    expect(continuity.getMerged({
      canonicalUserId: 'contact-1',
      fallbackUserIds: [],
      limit: 10,
      channelId: 'api:private-main',
    })).toEqual([]);
    expect(continuity.getActiveChannels('contact-1')).toEqual([]);
  });
});
