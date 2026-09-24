import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../../core/session/types.js';
import { buildSessionMetadataWithSpeakerAttribution } from '../../../../core/session/speaker-attribution.js';
import {
  UNRESOLVED_EPISODE_PARTICIPANT,
  type Episode,
} from '../../../../shared/contracts/episodic-memory.js';
import { isEpisodeVisibleToSubject } from '../subject-authorized-store.js';
import { resolveEpisodeParticipantContactIds } from './participant-attribution.js';

let nextId = 1;
function entry(
  role: SessionEntry['role'],
  authorId: string,
  canonicalContactId?: string,
): SessionEntry {
  const id = nextId++;
  return {
    id,
    channelId: 'discord:guild-room',
    role,
    content: `message ${id}`,
    authorId,
    timestamp: 1_700_000_000_000 + id,
    ...(canonicalContactId
      ? { metadata: buildSessionMetadataWithSpeakerAttribution(undefined, canonicalContactId) }
      : {}),
  };
}

function episodeWith(participantContactIds: string[]): Episode {
  return { participantContactIds } as unknown as Episode;
}

const ALEX = '4f1d8e02-8f6a-4b8e-9d64-0c7b2f3a1e11';
const BLAIR = '9a2c7b14-1e3d-4a5f-8b6c-2d7e8f9a0b22';

describe('resolveEpisodeParticipantContactIds (bs4m0)', () => {
  it('uses the proven canonical contact id, never the raw author id', () => {
    const ids = resolveEpisodeParticipantContactIds([
      entry('user', 'discord-user-111', ALEX),
      entry('assistant', 'companion:lyra'),
    ]);
    expect(ids).toEqual([ALEX]);
    expect(ids).not.toContain('discord-user-111');
    expect(ids).not.toContain('companion:lyra');
  });

  it('a raw author id equal to another contact id grants that contact nothing', () => {
    // The raw channel id happens to equal BLAIR's canonical id, but the entry
    // is attributed to ALEX: BLAIR must not gain visibility.
    const ids = resolveEpisodeParticipantContactIds([entry('user', BLAIR, ALEX)]);
    expect(isEpisodeVisibleToSubject(episodeWith(ids), { viewerContactId: BLAIR })).toBe(false);
    expect(isEpisodeVisibleToSubject(episodeWith(ids), { viewerContactId: ALEX })).toBe(true);
  });

  it('keeps both correctly attributed humans in a two-human room', () => {
    const ids = resolveEpisodeParticipantContactIds([
      entry('user', 'discord-user-111', ALEX),
      entry('user', 'discord-user-222', BLAIR),
      entry('user', 'discord-user-111', ALEX),
    ]);
    expect(ids).toEqual([ALEX, BLAIR].sort());
    for (const viewer of [ALEX, BLAIR]) {
      expect(isEpisodeVisibleToSubject(episodeWith(ids), { viewerContactId: viewer })).toBe(true);
    }
  });

  it('withholds an unknown speaker and keeps the episode out of the unattributed admin projection', () => {
    const ids = resolveEpisodeParticipantContactIds([entry('user', 'discord-user-333')]);
    expect(ids).toEqual([UNRESOLVED_EPISODE_PARTICIPANT]);
    expect(isEpisodeVisibleToSubject(episodeWith(ids), { viewerContactId: 'discord-user-333' })).toBe(false);
    expect(isEpisodeVisibleToSubject(episodeWith(ids), {
      viewerContactId: ALEX,
      adminAccessMode: 'multi_admin',
    })).toBe(false);
  });

  it('keeps a proven participant visible when another speaker is unresolved', () => {
    const ids = resolveEpisodeParticipantContactIds([
      entry('user', 'discord-user-111', ALEX),
      entry('user', 'discord-user-333'),
    ]);
    expect(ids).toEqual([ALEX, UNRESOLVED_EPISODE_PARTICIPANT].sort());
    expect(isEpisodeVisibleToSubject(episodeWith(ids), { viewerContactId: ALEX })).toBe(true);
  });

  it('withholds an author whose entries carry conflicting canonical attributions', () => {
    const ids = resolveEpisodeParticipantContactIds([
      entry('user', 'discord-user-111', ALEX),
      entry('user', 'discord-user-111', BLAIR),
    ]);
    expect(ids).toEqual([UNRESOLVED_EPISODE_PARTICIPANT]);
    for (const viewer of [ALEX, BLAIR]) {
      expect(isEpisodeVisibleToSubject(episodeWith(ids), { viewerContactId: viewer })).toBe(false);
    }
  });

  it('rejects malformed attribution instead of reading it as a contact', () => {
    const malformed: SessionEntry = {
      ...entry('user', 'discord-user-111'),
      metadata: JSON.stringify({ speakerAttribution: { schemaVersion: 1, canonicalContactId: 42 } }),
    };
    expect(() => resolveEpisodeParticipantContactIds([malformed])).toThrow(/canonicalContactId/);
  });

  it('returns no participants for an episode with no user speakers', () => {
    expect(resolveEpisodeParticipantContactIds([entry('assistant', 'companion:lyra')])).toEqual([]);
  });
});
