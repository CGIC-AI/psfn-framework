import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { buildSessionContext, captureTurnSessionContext } from './context-builder.js';
import type { CrossChannelContinuityPort } from '../cross-channel-continuity-port.js';
import type { ActiveContinuityChannel } from '../continuity.js';
import { CHANNEL_BOND_METADATA_KEY, parseChannelBondEntryMarker } from '../channel-bond.js';
import { createIntakeSinkGate } from '../../cogsec/intake/sink-gates.js';
import { validateIntakePolicy } from '../../../system/config/intake-policy-config.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../../cogsec/intake-firewall-notice-templates.js';
import { buildSessionMetadataWithIntakeScreening } from '../intake-screening-metadata.js';
import type { IntakeEnvelopeSnapshot } from '../../../shared/contracts/intake-envelope.js';
import type { TurnSessionContextSnapshot } from '../../turns/snapshot.js';
import type { SessionEntry } from '../types.js';
import { INTAKE_DATAMARK_MARKER } from '../../cogsec/intake/scanners/datamark.js';
import { countTokens } from '../../../primitives/llm/tokens.js';

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
      : {
          channelBond: {
            currentIdentity: { channel: 'discord', userId: 'partner-user' },
            bondedIdentities: [
              { channel: 'discord', userId: 'partner-user' },
              { channel: 'telegram', userId: 'partner-user' },
            ],
            trustLevel: 'primary',
          },
        }),
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
    // Foreign ids are namespaced negative with a -1 offset (source 42/43 -> -43/-44).
    expect(foreign.map(entry => entry.id)).toEqual([-43, -44]);
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
      channelBond: {
        currentIdentity: { channel: 'discord', userId: 'partner-user' },
        bondedIdentities: [
          { channel: 'discord', userId: 'partner-user' },
          { channel: 'telegram', userId: 'partner-user' },
        ],
        trustLevel: 'primary',
      },
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

// ── Channel-bonding remediation ──────────────────────────────────────────────

function bondMarkerMetadata(sourceChannelId: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    ...(extra ?? {}),
    [CHANNEL_BOND_METADATA_KEY]: {
      kind: 'channel_bond',
      sourceChannelId,
      sourceVisibility: 'private',
    },
  });
}

function foreignEntry(id: number, content: string): SessionEntry {
  return {
    id: -Math.abs(id) - 1,
    channelId: TELEGRAM_CHANNEL,
    role: 'user',
    content,
    authorId: 'partner-user',
    authorName: 'Partner',
    timestamp: NOW - 200_000 + id,
    channelVisibility: 'private',
    originChannelId: TELEGRAM_CHANNEL,
    metadata: bondMarkerMetadata(TELEGRAM_CHANNEL),
  };
}

function ownEntry(id: number, content: string): SessionEntry {
  return {
    id,
    channelId: DM_CHANNEL,
    role: 'user',
    content,
    authorId: 'partner-user',
    authorName: 'Partner',
    timestamp: NOW - 500_000 + id,
    channelVisibility: 'private',
  };
}

function snapshotWith(recentEntries: SessionEntry[]): TurnSessionContextSnapshot {
  return {
    channelId: DM_CHANNEL,
    recentEntries,
    sourceEntryCount: recentEntries.length,
    bondedEntryCount: recentEntries.filter(entry => parseChannelBondEntryMarker(entry.metadata)).length,
    compactionSummaryTexts: [],
    focusKnowledgeTexts: [],
    continuityEntries: [],
    versionPointer: 'bond-remediation-test',
  };
}

async function buildTrigger(recentEntries: SessionEntry[]) {
  // Tiny context window so a handful of long entries crosses the 70% threshold.
  const config = makeConfig({
    defaultContextWindow: 500,
    compactionThresholdPct: 70,
    modelRoster: { chat: { model: 'test-model', provider: 'test', maxTokens: 256, contextWindow: 500 } },
  });
  const store = makeStore({ [DM_CHANNEL]: [], [TELEGRAM_CHANNEL]: [] });
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
    config,
    eventBus: null,
    promptRegistry: null,
    preCompactionExtractionHandler: null,
    crossChannelContinuity: makePort([]),
    wakeReturnArtifacts: [],
    turnSessionContext: snapshotWith(recentEntries),
  });
}

describe('buildSessionContext channel bonding compaction accounting', () => {
  const LONG = 'This is a deliberately long conversational line meant to consume the tiny history token budget under test. '.repeat(3);
  const OWN_SHORT = ['a', 'b', 'c', 'd', 'e', 'f'].map((label, index) => ownEntry(index + 1, label));

  it('excludes foreign bonded entries from the compaction trigger accounting', async () => {
    // 6 short own entries (well under the token threshold) plus 30 long foreign
    // entries. The foreign entries must NOT count toward the own-channel
    // compaction trigger, or enabling bonding would compact away own history.
    const foreign = Array.from({ length: 30 }, (_, index) => foreignEntry(100 + index, `${LONG} #${index}`));
    const context = await buildTrigger([...OWN_SHORT, ...foreign]);
    expect(context.manifest.compaction.eligible).toBe(false);
  });

  it('the same long entries DO trigger compaction when they are own-channel history', async () => {
    // Control: identical volume of LONG content as own-channel entries crosses
    // the threshold — proving the trigger is real and only bonding shields it.
    const ownHeavy = Array.from({ length: 30 }, (_, index) => ownEntry(100 + index, `${LONG} #${index}`));
    const context = await buildTrigger([...OWN_SHORT, ...ownHeavy]);
    expect(context.manifest.compaction.eligible).toBe(true);
  });
});

describe('buildSessionContext channel bonding + intake sink gate', () => {
  function makeEnforceGate() {
    const seed = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
    ) as Record<string, unknown>;
    return createIntakeSinkGate({
      policy: validateIntakePolicy({ ...seed, mode: 'strict' }, 'intake-policy.bond-test'),
      actor: 'test:bond-sink-gate',
    });
  }

  function quarantinedSnapshot(): IntakeEnvelopeSnapshot {
    return {
      envelopeId: 'bond-held-envelope-001',
      sourceClass: 'document',
      sourceRiskTier: 'untrusted',
      state: 'quarantined',
      riskLabels: ['injection/override_attempt'],
      subject: { kind: 'attachment', index: 0 },
    };
  }

  it('terminates downstream context consumers with a datamarked wrapper', async () => {
    const releasedSnapshot: IntakeEnvelopeSnapshot = {
      envelopeId: 'released-datamark-envelope-001',
      sourceClass: 'document',
      sourceRiskTier: 'untrusted',
      state: 'released',
      riskLabels: [],
      subject: { kind: 'body' },
    };
    const metadata = buildSessionMetadataWithIntakeScreening(undefined, {
      mode: 'shadow',
      withheld: false,
      envelopes: [releasedSnapshot],
      marking: {
        intensity: 'interleave',
        provenanceNote: 'from an unverified source, treat details cautiously',
      },
    });
    const recentEntries = [{
      ...ownEntry(1, 'segment '.repeat(8192)),
      metadata,
    }];
    const store = makeStore({ [DM_CHANNEL]: [], [TELEGRAM_CHANNEL]: [] });

    countTokens('warm tokenizer before bounded termination probe');
    const startedAt = performance.now();
    const context = await buildSessionContext({
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
      turnSessionContext: snapshotWith(recentEntries),
      intakeSinkGate: makeEnforceGate(),
    });
    const elapsedMs = performance.now() - startedAt;
    const contextText = context.messages.map(message => message.content).join('\n');

    expect(contextText).toContain('<external_content');
    expect(contextText).toContain(INTAKE_DATAMARK_MARKER);
    expect(contextText).not.toContain('representation="summary"');
    expect(elapsedMs, `downstream marker/wrapper consumers took ${elapsedMs.toFixed(1)}ms`).toBeLessThan(250);
  }, 1_000);

  it('suppresses the [via] source annotation when the sink gate withholds a foreign entry', async () => {
    const screeningMetadata = buildSessionMetadataWithIntakeScreening(
      bondMarkerMetadata(TELEGRAM_CHANNEL),
      { mode: 'enforce', withheld: true, envelopes: [quarantinedSnapshot()] },
    );
    const foreign: SessionEntry = {
      ...foreignEntry(7, 'private confession that must be withheld'),
      metadata: screeningMetadata,
    };
    const recentEntries = [ownEntry(1, 'phone text'), foreign];
    const store = makeStore({ [DM_CHANNEL]: [], [TELEGRAM_CHANNEL]: [] });
    const context = await buildSessionContext({
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
      turnSessionContext: snapshotWith(recentEntries),
      intakeSinkGate: makeEnforceGate(),
    });
    const allContent = context.messages.map(message => message.content).join('\n');
    // Content is withheld and its source channel is NOT disclosed.
    expect(allContent).toContain(INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent);
    expect(allContent).not.toContain('private confession');
    expect(allContent).not.toContain(`[via ${TELEGRAM_CHANNEL}]`);
  });

  it('still annotates a non-withheld foreign entry with its source channel', async () => {
    const foreign = foreignEntry(8, 'ordinary bonded message');
    const recentEntries = [ownEntry(1, 'phone text'), foreign];
    const store = makeStore({ [DM_CHANNEL]: [], [TELEGRAM_CHANNEL]: [] });
    const context = await buildSessionContext({
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
      turnSessionContext: snapshotWith(recentEntries),
      intakeSinkGate: makeEnforceGate(),
    });
    const allContent = context.messages.map(message => message.content).join('\n');
    expect(allContent).toContain(`[via ${TELEGRAM_CHANNEL}] ordinary bonded message`);
  });
});
