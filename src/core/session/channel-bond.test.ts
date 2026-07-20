import { describe, expect, it } from 'vitest';
import {
  CHANNEL_BOND_METADATA_KEY,
  parseChannelBondEntryMarker,
  resolveBondedSessionTimeline,
  resolveChannelPlatformKey,
  resolveEffectiveBondDisclosure,
  sortBondedTimelineEntries,
} from './channel-bond.js';
import type { CrossChannelContinuityPort } from './cross-channel-continuity-port.js';
import type { ActiveContinuityChannel } from './continuity.js';
import type { SessionEntry } from './types.js';

const NOW = 1_700_000_600_000;
const SPAN_MS = 24 * 60 * 60 * 1000;

function makeEntry(overrides: Partial<SessionEntry> & Pick<SessionEntry, 'id' | 'channelId'>): SessionEntry {
  return {
    role: 'user',
    content: `message ${overrides.id}`,
    authorId: 'vega-test-user',
    authorName: 'Partner',
    timestamp: NOW - 60_000,
    channelVisibility: 'private',
    ...overrides,
  };
}

function makeStore(byChannel: Record<string, SessionEntry[]>): { getRecent(channelId: string, limit: number): SessionEntry[] } {
  return {
    getRecent(channelId: string, limit: number): SessionEntry[] {
      const entries = byChannel[channelId] ?? [];
      return entries.slice(-Math.max(0, limit));
    },
  };
}

function makePort(activeChannels: ActiveContinuityChannel[]): CrossChannelContinuityPort {
  return {
    append: () => null,
    getMerged: () => [],
    getActiveChannels: () => activeChannels,
    parseProvenance: () => null,
    getHealth: () => ({ status: 'wired', detail: 'test' }),
  };
}

function activeChannel(channelId: string, channelVisibility: ActiveContinuityChannel['channelVisibility'] = 'private'): ActiveContinuityChannel {
  return { channelId, channelVisibility, lastTimestamp: NOW - 30_000 };
}

function resolveTimeline(overrides: Partial<Parameters<typeof resolveBondedSessionTimeline>[0]> = {}) {
  return resolveBondedSessionTimeline({
    bond: {
      currentIdentity: { channel: 'discord', userId: 'vega-test-user' },
      bondedIdentities: [
        { channel: 'discord', userId: 'vega-test-user' },
        { channel: 'telegram', userId: 'vega-test-user' },
        { channel: 'api', userId: 'vega-test-user' },
      ],
      trustLevel: 'primary',
    },
    continuityUserId: 'contact-1',
    channelId: 'discord:100',
    sourceChannelId: 'discord:100',
    channelMeta: { isDirectMessage: true },
    ownEntries: [],
    crossChannelContinuity: makePort([]),
    store: makeStore({}),
    maxHistorySpanMs: SPAN_MS,
    nowMs: NOW,
    ...overrides,
  });
}

describe('resolveChannelPlatformKey', () => {
  it('derives platform keys from channel ids and identity channels', () => {
    expect(resolveChannelPlatformKey('discord:1234')).toBe('discord');
    expect(resolveChannelPlatformKey('123456789012')).toBe('discord');
    expect(resolveChannelPlatformKey('discord-voice:55')).toBe('discord');
    expect(resolveChannelPlatformKey('telegram:777')).toBe('telegram');
    expect(resolveChannelPlatformKey('api:mobile:session-1')).toBe('api');
    expect(resolveChannelPlatformKey('satellite:presence')).toBe('satellite');
    expect(resolveChannelPlatformKey('discord')).toBe('discord');
    expect(resolveChannelPlatformKey('')).toBeNull();
    expect(resolveChannelPlatformKey('   ')).toBeNull();
  });
});

describe('resolveEffectiveBondDisclosure', () => {
  it('resolves an all-private set to private', () => {
    expect(resolveEffectiveBondDisclosure([
      { channelPrivacy: 'private', broadcast: false },
      { channelPrivacy: 'private', broadcast: false },
    ])).toEqual({ channelPrivacy: 'private', broadcast: false });
  });

  it('resolves all-private-except-one-invite-only to invite_only (bead example)', () => {
    expect(resolveEffectiveBondDisclosure([
      { channelPrivacy: 'private', broadcast: false },
      { channelPrivacy: 'private', broadcast: false },
      { channelPrivacy: 'invite_only', broadcast: false },
    ])).toEqual({ channelPrivacy: 'invite_only', broadcast: false });
  });

  it('resolves a set containing a public member to public', () => {
    expect(resolveEffectiveBondDisclosure([
      { channelPrivacy: 'private', broadcast: false },
      { channelPrivacy: 'public', broadcast: false },
    ])).toEqual({ channelPrivacy: 'public', broadcast: false });
  });

  it('returns null for an empty set', () => {
    expect(resolveEffectiveBondDisclosure([])).toBeNull();
  });
});

describe('parseChannelBondEntryMarker', () => {
  it('round-trips a marker embedded in a metadata envelope', () => {
    const metadata = JSON.stringify({
      other: { keep: true },
      [CHANNEL_BOND_METADATA_KEY]: {
        kind: 'channel_bond',
        sourceChannelId: 'telegram:777',
        sourceVisibility: 'private',
      },
    });
    expect(parseChannelBondEntryMarker(metadata)).toEqual({
      kind: 'channel_bond',
      sourceChannelId: 'telegram:777',
      sourceVisibility: 'private',
    });
  });

  it('returns null for absent, malformed, or foreign metadata', () => {
    expect(parseChannelBondEntryMarker(undefined)).toBeNull();
    expect(parseChannelBondEntryMarker('not json channelBond')).toBeNull();
    expect(parseChannelBondEntryMarker(JSON.stringify({ turn: 'x' }))).toBeNull();
    expect(parseChannelBondEntryMarker(JSON.stringify({
      [CHANNEL_BOND_METADATA_KEY]: { kind: 'channel_bond', sourceChannelId: 'a', sourceVisibility: 'nonsense' },
    }))).toBeNull();
  });
});

describe('resolveBondedSessionTimeline', () => {
  it('interleaves a bonded three-channel conversation by timestamp with source markers', () => {
    const ownEntries = [
      makeEntry({ id: 1, channelId: 'discord:100', timestamp: NOW - 500_000, content: 'phone text' }),
      makeEntry({ id: 2, channelId: 'discord:100', role: 'assistant', timestamp: NOW - 490_000, content: 'phone reply' }),
    ];
    const result = resolveTimeline({
      ownEntries,
      crossChannelContinuity: makePort([
        activeChannel('telegram:777'),
        activeChannel('api:mobile:sess'),
      ]),
      store: makeStore({
        'telegram:777': [
          makeEntry({ id: 7, channelId: 'telegram:777', timestamp: NOW - 400_000, content: 'bedroom voice' }),
        ],
        'api:mobile:sess': [
          makeEntry({ id: 3, channelId: 'api:mobile:sess', timestamp: NOW - 450_000, content: 'kitchen satellite' }),
          makeEntry({ id: 4, channelId: 'api:mobile:sess', role: 'assistant', timestamp: NOW - 440_000, content: 'kitchen reply' }),
        ],
      }),
    });

    expect(result).not.toBeNull();
    expect(result?.effectivePrivacy).toBe('private');
    expect(result?.bondedEntryCount).toBe(3);
    expect(result?.memberChannelIds).toEqual(['api:mobile:sess', 'telegram:777']);
    expect(result?.entries.map(entry => entry.content)).toEqual([
      'phone text',
      'phone reply',
      'kitchen satellite',
      'kitchen reply',
      'bedroom voice',
    ]);
    const foreign = result?.entries.filter(entry => parseChannelBondEntryMarker(entry.metadata)) ?? [];
    expect(foreign).toHaveLength(3);
    for (const entry of foreign) {
      expect(entry.id).toBeLessThan(0);
      expect(entry.originChannelId).toBe(entry.channelId);
      expect(parseChannelBondEntryMarker(entry.metadata)?.sourceChannelId).toBe(entry.channelId);
    }
    // Own entries stay unmarked and keep their positive ids.
    const own = result?.entries.filter(entry => !parseChannelBondEntryMarker(entry.metadata)) ?? [];
    expect(own.map(entry => entry.id)).toEqual([1, 2]);
  });

  it('namespaces a source id of 0 to a strictly-negative foreign id (id contract holds for ids >= 0)', () => {
    const result = resolveTimeline({
      ownEntries: [makeEntry({ id: 1, channelId: 'discord:100' })],
      crossChannelContinuity: makePort([activeChannel('telegram:777')]),
      store: makeStore({
        'telegram:777': [makeEntry({ id: 0, channelId: 'telegram:777', content: 'zero-id message' })],
      }),
    });
    const foreign = result?.entries.filter(entry => parseChannelBondEntryMarker(entry.metadata)) ?? [];
    expect(foreign).toHaveLength(1);
    // `-0 < 0` is false in JS; the -1 offset keeps the id strictly negative.
    expect(foreign[0].id).toBeLessThan(0);
    expect(Object.is(foreign[0].id, -0)).toBe(false);
  });

  it('returns null when the current channel platform is not part of the bonded set', () => {
    const result = resolveTimeline({
      bond: {
        currentIdentity: { channel: 'discord', userId: 'vega-test-user' },
        bondedIdentities: [{ channel: 'telegram', userId: 'vega-test-user' }],
        trustLevel: 'primary',
      },
      crossChannelContinuity: makePort([activeChannel('telegram:777')]),
      store: makeStore({
        'telegram:777': [makeEntry({ id: 7, channelId: 'telegram:777' })],
      }),
    });
    expect(result).toBeNull();
  });

  it('returns null without a continuity identity', () => {
    expect(resolveTimeline({ continuityUserId: undefined })).toBeNull();
    expect(resolveTimeline({ continuityUserId: '  ' })).toBeNull();
  });

  it('returns null when no bonded member channels are active', () => {
    expect(resolveTimeline({
      crossChannelContinuity: makePort([activeChannel('wyoming:kitchen')]),
      store: makeStore({
        'wyoming:kitchen': [makeEntry({ id: 5, channelId: 'wyoming:kitchen' })],
      }),
    })).toBeNull();
  });

  it('excludes a same-platform group log containing an unbonded participant', () => {
    const result = resolveTimeline({
      crossChannelContinuity: makePort([activeChannel('telegram:group:777')]),
      store: makeStore({
        'telegram:group:777': [
          makeEntry({
            id: 7,
            channelId: 'telegram:group:777',
            authorId: 'vega-test-user',
            content: 'bonded partner message',
          }),
          makeEntry({
            id: 8,
            channelId: 'telegram:group:777',
            authorId: 'unbonded-third-party',
            content: 'private group participant message',
          }),
        ],
      }),
    });

    expect(result).toBeNull();
  });

  it('fails closed when a member channel privacy cannot be determined', () => {
    const result = resolveTimeline({
      crossChannelContinuity: makePort([
        activeChannel('telegram:777'),
        activeChannel('api:mobile:sess'),
      ]),
      store: makeStore({
        'telegram:777': [makeEntry({ id: 7, channelId: 'telegram:777' })],
        // No parseable persisted visibility on ANY entry: the whole bond must
        // stay down — including the otherwise-admissible telegram member.
        'api:mobile:sess': [
          makeEntry({ id: 3, channelId: 'api:mobile:sess', channelVisibility: undefined }),
          makeEntry({ id: 4, channelId: 'api:mobile:sess', channelVisibility: 'garbage-label' }),
        ],
      }),
    });
    expect(result).toBeNull();
  });

  it('enforces lowest-common privacy: higher-privacy sources never cross a mixed bond', () => {
    const result = resolveTimeline({
      ownEntries: [makeEntry({ id: 1, channelId: 'discord:100', timestamp: NOW - 500_000 })],
      crossChannelContinuity: makePort([
        activeChannel('telegram:777', 'private'),
        activeChannel('api:mobile:sess', 'invite_only'),
      ]),
      store: makeStore({
        'telegram:777': [
          makeEntry({ id: 7, channelId: 'telegram:777', channelVisibility: 'private', content: 'private-only detail' }),
        ],
        'api:mobile:sess': [
          makeEntry({ id: 3, channelId: 'api:mobile:sess', channelVisibility: 'invite_only', content: 'invite-only chatter' }),
        ],
      }),
    });

    // Effective privacy is invite_only (most restrictive of the set): the
    // private member's content must not circulate, the invite_only member's may.
    expect(result).not.toBeNull();
    expect(result?.effectivePrivacy).toBe('invite_only');
    expect(result?.memberChannelIds).toEqual(['api:mobile:sess']);
    const contents = result?.entries.map(entry => entry.content) ?? [];
    expect(contents).toContain('invite-only chatter');
    expect(contents).not.toContain('private-only detail');
  });

  it('never renders higher-privacy content into a lower-privacy current channel', () => {
    const result = resolveTimeline({
      // Current channel is PUBLIC; the bonded member's log is private.
      channelMeta: { privacyLevel: 'public' },
      ownEntries: [makeEntry({ id: 1, channelId: 'discord:100', channelVisibility: 'public' })],
      crossChannelContinuity: makePort([activeChannel('telegram:777', 'private')]),
      store: makeStore({
        'telegram:777': [
          makeEntry({ id: 7, channelId: 'telegram:777', channelVisibility: 'private', content: 'private confession' }),
        ],
      }),
    });
    // No admissible foreign entries -> the bond resolves nothing at all.
    expect(result).toBeNull();
  });

  it('applies the trust ceiling through the memory policy gate', () => {
    // A 'regular' trust contact cannot carry confidential-ceiling (private
    // source) content across channels; the same shape passes at 'primary'.
    const build = (trustLevel: 'primary' | 'regular') => resolveTimeline({
      bond: {
        currentIdentity: { channel: 'discord', userId: 'vega-test-user' },
        bondedIdentities: [
          { channel: 'discord', userId: 'vega-test-user' },
          { channel: 'telegram', userId: 'vega-test-user' },
        ],
        trustLevel,
      },
      ownEntries: [makeEntry({ id: 1, channelId: 'discord:100' })],
      crossChannelContinuity: makePort([activeChannel('telegram:777')]),
      store: makeStore({
        'telegram:777': [makeEntry({ id: 7, channelId: 'telegram:777' })],
      }),
    });
    expect(build('primary')).not.toBeNull();
    expect(build('regular')).toBeNull();
  });

  it('drops own-log mirror notes whose source conversation is interleaved', () => {
    const mirrorMetadata = JSON.stringify({
      type: 'mirror',
      sourceChannelId: 'telegram:777',
      sourceRole: 'user',
      sourceVisibility: 'private',
      trustLevel: 'primary',
      mirroredAt: NOW - 400_000,
      truncated: false,
    });
    const result = resolveTimeline({
      ownEntries: [
        makeEntry({ id: 1, channelId: 'discord:100', timestamp: NOW - 500_000 }),
        makeEntry({
          id: 2,
          channelId: 'discord:100',
          role: 'system',
          timestamp: NOW - 400_000,
          content: 'Partner [from telegram:777]: bedroom voice',
          metadata: mirrorMetadata,
        }),
      ],
      crossChannelContinuity: makePort([activeChannel('telegram:777')]),
      store: makeStore({
        'telegram:777': [
          makeEntry({ id: 7, channelId: 'telegram:777', timestamp: NOW - 400_000, content: 'bedroom voice' }),
        ],
      }),
    });

    expect(result).not.toBeNull();
    expect(result?.suppressedMirrorEntryCount).toBe(1);
    expect(result?.entries.some(entry => entry.role === 'system')).toBe(false);
    expect(result?.entries.filter(entry => entry.content === 'bedroom voice')).toHaveLength(1);
  });

  it('excludes member entries whose metadata envelope cannot be preserved', () => {
    const result = resolveTimeline({
      ownEntries: [makeEntry({ id: 1, channelId: 'discord:100' })],
      crossChannelContinuity: makePort([activeChannel('telegram:777')]),
      store: makeStore({
        'telegram:777': [
          makeEntry({ id: 7, channelId: 'telegram:777', content: 'clean', timestamp: NOW - 200_000 }),
          makeEntry({ id: 8, channelId: 'telegram:777', content: 'broken metadata', metadata: '{{{not json', timestamp: NOW - 100_000 }),
        ],
      }),
    });
    const contents = result?.entries.map(entry => entry.content) ?? [];
    expect(contents).toContain('clean');
    expect(contents).not.toContain('broken metadata');
  });

  it('preserves existing metadata (intake taint) alongside the bond marker', () => {
    const taintedMetadata = JSON.stringify({
      intakeScreening: { schemaVersion: 1, mode: 'enforce', withheld: false, envelopes: [{ ref: 'x' }] },
    });
    const result = resolveTimeline({
      ownEntries: [makeEntry({ id: 1, channelId: 'discord:100' })],
      crossChannelContinuity: makePort([activeChannel('telegram:777')]),
      store: makeStore({
        'telegram:777': [
          makeEntry({ id: 7, channelId: 'telegram:777', metadata: taintedMetadata }),
        ],
      }),
    });
    const foreign = result?.entries.find(entry => parseChannelBondEntryMarker(entry.metadata));
    expect(foreign).toBeDefined();
    const parsed = JSON.parse(foreign?.metadata ?? '{}') as Record<string, unknown>;
    expect(parsed.intakeScreening).toEqual({
      schemaVersion: 1,
      mode: 'enforce',
      withheld: false,
      envelopes: [{ ref: 'x' }],
    });
    expect(parsed[CHANNEL_BOND_METADATA_KEY]).toMatchObject({ kind: 'channel_bond' });
  });

  it('only merges conversational entries from members', () => {
    const result = resolveTimeline({
      ownEntries: [makeEntry({ id: 1, channelId: 'discord:100' })],
      crossChannelContinuity: makePort([activeChannel('telegram:777')]),
      store: makeStore({
        'telegram:777': [
          makeEntry({ id: 6, channelId: 'telegram:777', role: 'system', content: 'system note', timestamp: NOW - 300_000 }),
          makeEntry({ id: 7, channelId: 'telegram:777', role: 'tool', content: 'tool output', timestamp: NOW - 250_000 }),
          makeEntry({ id: 8, channelId: 'telegram:777', content: 'actual message', timestamp: NOW - 200_000 }),
        ],
      }),
    });
    const contents = result?.entries.map(entry => entry.content) ?? [];
    expect(contents).toContain('actual message');
    expect(contents).not.toContain('system note');
    expect(contents).not.toContain('tool output');
  });
});

describe('sortBondedTimelineEntries', () => {
  it('orders by timestamp with own entries before foreign at the same instant', () => {
    const marker = JSON.stringify({
      [CHANNEL_BOND_METADATA_KEY]: {
        kind: 'channel_bond',
        sourceChannelId: 'telegram:777',
        sourceVisibility: 'private',
      },
    });
    const foreign = makeEntry({ id: -7, channelId: 'telegram:777', timestamp: NOW, metadata: marker, content: 'foreign' });
    const own = makeEntry({ id: 9, channelId: 'discord:100', timestamp: NOW, content: 'own' });
    expect(sortBondedTimelineEntries([foreign, own]).map(entry => entry.content)).toEqual(['own', 'foreign']);
  });
});
