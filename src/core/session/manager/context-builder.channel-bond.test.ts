import { describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { buildSessionContext, captureTurnSessionContext } from './context-builder.js';
import type { CrossChannelContinuityPort } from '../cross-channel-continuity-port.js';
import type { ActiveContinuityChannel } from '../continuity.js';
import { parseChannelBondEntryMarker } from '../channel-bond.js';
import type { SessionEntry } from '../types.js';

const NOW = Date.now();

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionHistoryBudgetPct: 50,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 2000 },
    },
    ...overrides,
  };
}

function makeEntry(overrides: Partial<SessionEntry> & Pick<SessionEntry, 'id' | 'channelId'>): SessionEntry {
  return {
    role: 'user',
    content: `message ${overrides.id}`,
    authorId: 'partner-user',
    authorName: 'Partner',
    timestamp: NOW - 60_000,
    channelVisibility: 'private',
    ...overrides,
  };
}

function makeStore(byChannel: Record<string, SessionEntry[]>): never {
  return {
    getRecent(channelId: string, limit: number): SessionEntry[] {
      const entries = byChannel[channelId] ?? [];
      return entries.slice(-Math.max(0, limit));
    },
    getCompactionSummaries: () => [],
  } as never;
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

const DM_CHANNEL = 'discord:100';
const TELEGRAM_CHANNEL = 'telegram:777';

function ownEntries(): SessionEntry[] {
  return [
    makeEntry({ id: 1, channelId: DM_CHANNEL, timestamp: NOW - 500_000, content: 'phone text' }),
    makeEntry({ id: 2, channelId: DM_CHANNEL, role: 'assistant', timestamp: NOW - 490_000, content: 'phone reply' }),
  ];
}

function memberEntries(): SessionEntry[] {
  return [
    makeEntry({ id: 42, channelId: TELEGRAM_CHANNEL, timestamp: NOW - 400_000, content: 'bedroom voice' }),
    makeEntry({ id: 43, channelId: TELEGRAM_CHANNEL, role: 'assistant', timestamp: NOW - 390_000, content: 'bedroom reply' }),
  ];
}

async function capture(options: {
  bonded?: boolean;
  memberVisibility?: string | undefined;
  port?: CrossChannelContinuityPort;
  excludeSessionEntryId?: number;
} = {}) {
  const store = makeStore({
    [DM_CHANNEL]: ownEntries(),
    [TELEGRAM_CHANNEL]: memberEntries().map(entry => ({
      ...entry,
      ...(options.memberVisibility === undefined && 'memberVisibility' in options
        ? { channelVisibility: undefined }
        : options.memberVisibility !== undefined
          ? { channelVisibility: options.memberVisibility }
          : {}),
    })),
  });
  return await captureTurnSessionContext({
    channelId: DM_CHANNEL,
    sourceChannelId: DM_CHANNEL,
    userId: 'contact-1',
    channelMeta: { isDirectMessage: true },
    continuityFallbackUserIds: [],
    config: makeConfig(),
    store,
    activityStore: store,
    crossChannelContinuity: options.port ?? makePort([
      { channelId: TELEGRAM_CHANNEL, channelVisibility: 'private', lastTimestamp: NOW - 300_000 },
    ]),
    focusCompactionRanges: [],
    focusKnowledgeTexts: [],
    wakeReturnArtifacts: [],
    compactionPromptText: 'Summarize history.',
    promptRegistry: null,
    ...(options.excludeSessionEntryId !== undefined
      ? { excludeSessionEntryId: options.excludeSessionEntryId }
      : {}),
    ...(options.bonded === false
      ? {}
      : { channelBond: { bondedPlatforms: ['discord', 'telegram'], trustLevel: 'primary' } }),
  });
}

describe('captureTurnSessionContext channel bonding', () => {
  it('captures a bonded set as one interleaved timeline with source markers', async () => {
    const snapshot = await capture();
    expect(snapshot.bondedEntryCount).toBe(2);
    expect(snapshot.bondedMemberChannelIds).toEqual([TELEGRAM_CHANNEL]);
    expect(snapshot.bondedEffectivePrivacy).toBe('private');
    expect(snapshot.recentEntries.map(entry => entry.content)).toEqual([
      'phone text',
      'phone reply',
      'bedroom voice',
      'bedroom reply',
    ]);
    const foreign = snapshot.recentEntries.filter(entry => parseChannelBondEntryMarker(entry.metadata));
    expect(foreign.map(entry => entry.id)).toEqual([-42, -43]);
    expect(snapshot.versionPointer).not.toBe((await capture({ bonded: false })).versionPointer);
  });

  it('leaves unbonded channels untouched and never queries the continuity thread (opt-in default off)', async () => {
    const throwingPort: CrossChannelContinuityPort = {
      append: () => null,
      getMerged: () => [],
      getActiveChannels: () => {
        throw new Error('getActiveChannels must not be called without a bond opt-in');
      },
      parseProvenance: () => null,
      getHealth: () => ({ status: 'wired', detail: 'test' }),
    };
    const snapshot = await capture({ bonded: false, port: throwingPort });
    expect(snapshot.bondedEntryCount).toBeUndefined();
    expect(snapshot.bondedMemberChannelIds).toBeUndefined();
    expect(snapshot.recentEntries.map(entry => entry.content)).toEqual(['phone text', 'phone reply']);
    expect(snapshot.recentEntries.every(entry => parseChannelBondEntryMarker(entry.metadata) === null)).toBe(true);
  });

  it('fails closed when a bonded member has no determinable privacy', async () => {
    const snapshot = await capture({ memberVisibility: undefined });
    expect(snapshot.bondedEntryCount).toBeUndefined();
    expect(snapshot.recentEntries.map(entry => entry.content)).toEqual(['phone text', 'phone reply']);
  });

  it('never widens a lower-privacy channel with higher-privacy bonded content', async () => {
    const store = makeStore({
      // Current channel is a PUBLIC surface; the bonded member log is private.
      'discord:100': ownEntries().map(entry => ({ ...entry, channelVisibility: 'public' })),
      [TELEGRAM_CHANNEL]: memberEntries(),
    });
    const snapshot = await captureTurnSessionContext({
      channelId: DM_CHANNEL,
      sourceChannelId: DM_CHANNEL,
      userId: 'contact-1',
      channelMeta: { privacyLevel: 'public' },
      continuityFallbackUserIds: [],
      config: makeConfig(),
      store,
      activityStore: store,
      crossChannelContinuity: makePort([
        { channelId: TELEGRAM_CHANNEL, channelVisibility: 'private', lastTimestamp: NOW - 300_000 },
      ]),
      focusCompactionRanges: [],
      focusKnowledgeTexts: [],
      wakeReturnArtifacts: [],
      compactionPromptText: 'Summarize history.',
      promptRegistry: null,
      channelBond: { bondedPlatforms: ['discord', 'telegram'], trustLevel: 'primary' },
    });
    expect(snapshot.bondedEntryCount).toBeUndefined();
    expect(JSON.stringify(snapshot.recentEntries)).not.toContain('bedroom voice');
  });
});

describe('buildSessionContext channel bonding', () => {
  async function buildFromSnapshot(excludeSessionEntryId?: number) {
    const snapshot = await capture();
    const store = makeStore({
      [DM_CHANNEL]: ownEntries(),
      [TELEGRAM_CHANNEL]: memberEntries(),
    });
    return await buildSessionContext({
      channelId: DM_CHANNEL,
      sourceChannelId: DM_CHANNEL,
      systemPrompt: 'System prompt.',
      coreMemoryBlock: '',
      memoriesBlock: '',
      userId: 'contact-1',
      channelMeta: { isDirectMessage: true },
      continuityFallbackUserIds: [],
      store,
      config: makeConfig(),
      eventBus: null,
      promptRegistry: null,
      preCompactionExtractionHandler: null,
      crossChannelContinuity: makePort([]),
      wakeReturnArtifacts: [],
      turnSessionContext: snapshot,
      ...(excludeSessionEntryId !== undefined ? { excludeSessionEntryId } : {}),
    });
  }

  it('renders foreign user turns with a source-channel annotation and assistant turns without one', async () => {
    const context = await buildFromSnapshot();
    const allContent = context.messages.map(message => message.content).join('\n');
    expect(allContent).toContain(`[via ${TELEGRAM_CHANNEL}] bedroom voice`);
    // Assistant history is never source-prefixed (stamp-mimicry guard).
    const assistantContent = context.messages
      .filter(message => message.role === 'assistant')
      .map(message => message.content)
      .join('\n');
    expect(assistantContent).toContain('bedroom reply');
    expect(assistantContent).not.toContain('[via');
    expect(context.manifest.session.bondedEntryCount).toBe(2);
  });

  it('keeps interleaved timestamp order across channels in the rendered history', async () => {
    const context = await buildFromSnapshot();
    const allContent = context.messages.map(message => message.content).join('\n');
    const phoneIndex = allContent.indexOf('phone text');
    const bedroomIndex = allContent.indexOf('bedroom voice');
    expect(phoneIndex).toBeGreaterThanOrEqual(0);
    expect(bedroomIndex).toBeGreaterThan(phoneIndex);
  });

  it('does not confuse a foreign entry with the excluded current turn on id collision', async () => {
    // Member entry has store id 42; excluding own entry id 42 must not drop
    // the bonded foreign entry (foreign ids are namespaced negative).
    const context = await buildFromSnapshot(42);
    const allContent = context.messages.map(message => message.content).join('\n');
    expect(allContent).toContain('bedroom voice');
  });
});
