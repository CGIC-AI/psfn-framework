import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { UserContinuityStore } from './continuity.js';
import {
  createDisabledCrossChannelContinuityPort,
  createMissingCrossChannelContinuityPort,
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
    const privateTimestamp = Date.now();
    const fallbackTimestamp = privateTimestamp + 1;
    const sourceEntries = [
      {
        id: 41,
        channelId: 'api:private-main',
        role: 'user' as const,
        content: 'Private continuity note',
        authorId: 'contact-1',
        authorName: 'Alice',
        timestamp: privateTimestamp,
        originChannelId: 'api:private-main',
        channelVisibility: 'private',
      },
      {
        id: 72,
        channelId: '1234567890',
        role: 'assistant' as const,
        content: 'Fallback continuity note',
        timestamp: fallbackTimestamp,
        originChannelId: '1234567890',
        channelVisibility: 'invite_only',
      },
    ];
    const continuity = createUserContinuityPort(
      store,
      (channelId, minId, maxId) => sourceEntries.filter(
        entry => entry.channelId === channelId && entry.id >= minId && entry.id <= maxId,
      ),
      channelId => channelId === 'api:private-main' || channelId === '1234567890',
    );

    continuity.append({
      continuityUserId: 'contact-1',
      sourceEntryId: 41,
      entry: {
        channelId: 'api:private-main',
        role: 'user',
        content: 'Private continuity note',
        authorId: 'contact-1',
        authorName: 'Alice',
        timestamp: privateTimestamp,
        originChannelId: 'api:private-main',
        channelVisibility: 'private',
      },
    });
    continuity.append({
      continuityUserId: 'legacy-discord-1',
      sourceEntryId: 72,
      entry: {
        channelId: '1234567890',
        role: 'assistant',
        content: 'Fallback continuity note',
        timestamp: fallbackTimestamp,
        originChannelId: '1234567890',
        channelVisibility: 'invite_only',
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
      sourceEntryId: 72,
    }));
  });

  it('excludes unconfigured smoke channels before applying the result limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-cross-continuity-live-'));
    dirs.push(dir);
    const store = new UserContinuityStore(dir);
    const liveChannelIds = new Set(['api:primary', 'discord:linked-room']);
    const continuity = createUserContinuityPort(store, () => [], channelId => liveChannelIds.has(channelId));

    continuity.append({
      continuityUserId: 'contact-1',
      entry: {
        channelId: 'discord:linked-room',
        originChannelId: 'discord:linked-room',
        role: 'user',
        content: 'Live room continuity',
        authorId: 'contact-1',
        timestamp: 1_700_000_000_000,
        channelVisibility: 'private',
      },
    });
    continuity.append({
      continuityUserId: 'contact-1',
      entry: {
        channelId: 'api:head-pat-smoke',
        originChannelId: 'api:head-pat-smoke',
        role: 'assistant',
        content: 'Smoke-only continuity',
        timestamp: 1_700_000_001_000,
        channelVisibility: 'private',
      },
    });

    // Channel scoping keeps only the configured live room and drops the
    // unconfigured smoke channel before the limit applies. (Content is withheld
    // here because these fixtures carry no source-entry provenance — the origin
    // channel identity is what this test asserts.)
    expect(continuity.getMerged({
      canonicalUserId: 'contact-1',
      fallbackUserIds: [],
      limit: 1,
      channelId: 'api:primary',
    }).map(entry => entry.originChannelId ?? entry.channelId)).toEqual(['discord:linked-room']);
  });

  it('fails closed to empty results when no continuity store is wired', () => {
    const continuity = createMissingCrossChannelContinuityPort();

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
    expect(continuity.getHealth()).toEqual(expect.objectContaining({
      status: 'missing_wiring',
    }));
  });

  it('reports disabled state when continuity is intentionally turned off', () => {
    const continuity = createDisabledCrossChannelContinuityPort();

    expect(continuity.append({
      continuityUserId: 'contact-1',
      entry: {
        channelId: 'api:private-main',
        role: 'user',
        content: 'disabled',
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
    expect(continuity.getHealth()).toEqual(expect.objectContaining({
      status: 'disabled',
    }));
  });
});
