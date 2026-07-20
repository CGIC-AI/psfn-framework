// jp36.6.4 — classification-epoch integration join.
//
// Proves the wiring that feeds the persisted `channels.json`
// `contextEnvelope.classificationEpochs` records into jp36.6.3's epoch
// enforcement inputs end-to-end through production composition:
//   - the derivation (deriveChannelClassificationEpoch / current / as-of),
//   - hydration from a real channels.json via loadRuntimeChannelsConfig,
//   - the Garden acceptChannelDemotion write that stamps the epoch record,
//   - the egress ChannelDisclosureResolver composition (classifyChannelDisclosure
//     + currentChannelClassificationEpoch) — mirroring substrate-agent's
//     buildEgressToolGuard resolver,
//   - the session/memory lineage epoch params (conversationChannelEpoch /
//     sourceChannelEpoch) — mirroring turn-execution-runtime and the memory
//     collectDisclosureMemorySources population.
//
// Acceptance: content admitted pre-demotion is approval_required (allowed:false)
// to the demoted channel while post-acceptance content flows; channels with no
// epoch records behave byte-identically to the pre-epoch runtime.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntimeChannelsConfig } from '../../../channels/backplane/config.js';
import { createOwnerFileConfigStore } from '../../../system/config/config-store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { DEMOTION_EPOCH_NOTICE_VERSION } from '../../../system/trust/context-envelope.js';
import { AdminSettingsDataService } from '../../../operator/garden/services/settings-service.js';
import { classifyChannelDisclosure } from '../../../system/trust/policy.js';
import {
  resetRuntimeChannelEnvelopeLabels,
  setRuntimeChannelEnvelopeLabels,
} from '../../../system/trust/runtime-channel-labels.js';
import { resetRuntimeTrustPolicy } from '../../../system/trust/runtime-policy.js';
import {
  channelClassificationEpochAsOf,
  currentChannelClassificationEpoch,
  deriveChannelClassificationEpoch,
  resetRuntimeChannelClassificationEpochs,
  setRuntimeChannelClassificationEpochs,
} from '../../../system/trust/runtime-classification-epochs.js';
import type { ChannelClassificationEpoch, ContextEnvelope } from '../../../system/trust/context-envelope.js';
import { createGroupConversationScope } from '../../session/conversation-scope.js';
import {
  composeEgressDisclosureDecision,
  deriveDisclosureDestination,
} from './egress-composition.js';
import { buildGenerationDisclosureLineage, type DisclosureMemorySource } from './generation-lineage.js';
import type { GenerationDisclosureContext } from './contracts.js';

const CONTEXT: GenerationDisclosureContext = {
  generationContextRef: 'turn:jp36.6.4',
  classifierVersion: 'disclosure/v1',
  classifiedAt: '2026-07-20T00:00:00.000Z',
};
const INVITE_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'invite_only',
  audienceScope: 'few',
  audienceKnowledge: 'partially_known',
  broadcast: false,
};
const PUBLIC_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'public',
  audienceScope: 'many',
  audienceKnowledge: 'anonymous',
  broadcast: false,
};

const PROJECT_CHANNEL = 'room:project';
const LOBBY_CHANNEL = 'room:lobby';

let tempDir: string | null = null;

function makeRoot(channels: Record<string, unknown>): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-epoch-integration-'));
  writeFileSync(
    join(tempDir, 'trust-policy.json'),
    readFileSync(join(process.cwd(), 'config', 'trust-policy.seed.json'), 'utf8'),
    'utf8',
  );
  writeFileSync(
    join(tempDir, 'channels.json'),
    JSON.stringify({ contextEnvelope: { channels } }, null, 2),
    'utf8',
  );
  return tempDir;
}

function buildService(root: string): AdminSettingsDataService {
  const config = { dataDir: root, defaultContextWindow: 128_000 } as unknown as SubstrateConfig;
  return new AdminSettingsDataService({
    config,
    configStore: createOwnerFileConfigStore({ dataDir: root, defaultContextWindow: 128_000 }),
  });
}

/** Load channels.json and publish labels + epochs exactly as startup composition does. */
function hydrateFromOwnerFiles(root: string): void {
  const channelsConfig = loadRuntimeChannelsConfig(root, {});
  setRuntimeChannelEnvelopeLabels(channelsConfig.contextEnvelope.channels);
  setRuntimeChannelClassificationEpochs(channelsConfig.contextEnvelope.classificationEpochs);
}

/** Mirror of substrate-agent buildEgressToolGuard's ChannelDisclosureResolver. */
function resolveEgressChannel(channelId: string): {
  channelPrivacy: string;
  broadcast: boolean;
  classificationEpoch?: number;
} {
  const disclosure = classifyChannelDisclosure(channelId);
  const classificationEpoch = currentChannelClassificationEpoch(channelId);
  return classificationEpoch !== undefined ? { ...disclosure, classificationEpoch } : disclosure;
}

/** Mirror of memory collectDisclosureMemorySources: stamp the formation-time epoch. */
function memorySource(input: {
  id: string;
  sourceChannelId: string;
  sensitivity: DisclosureMemorySource['sensitivity'];
  extractedAt: number;
}): DisclosureMemorySource {
  const sourceChannelEpoch = channelClassificationEpochAsOf(
    input.sourceChannelId,
    new Date(input.extractedAt),
  );
  return {
    ref: `memory:${input.id}`,
    sensitivity: input.sensitivity,
    sourceChannelId: input.sourceChannelId,
    ...(sourceChannelEpoch !== undefined ? { sourceChannelEpoch } : {}),
  };
}

beforeEach(() => {
  resetRuntimeTrustPolicy();
  resetRuntimeChannelEnvelopeLabels();
  resetRuntimeChannelClassificationEpochs();
});

afterEach(() => {
  resetRuntimeTrustPolicy();
  resetRuntimeChannelEnvelopeLabels();
  resetRuntimeChannelClassificationEpochs();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('deriveChannelClassificationEpoch (monotonic count model)', () => {
  const epoch = (channelId: string, at: string): ChannelClassificationEpoch => ({
    channelId,
    from: 'invite_only',
    to: 'public',
    at,
    acceptedBy: 'operator:test',
    noticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
  });

  it('returns undefined for a channel with no records (untracked, byte-identical)', () => {
    expect(deriveChannelClassificationEpoch([], PROJECT_CHANNEL)).toBeUndefined();
    expect(deriveChannelClassificationEpoch(
      [epoch(LOBBY_CHANNEL, '2026-01-01T00:00:00.000Z')],
      PROJECT_CHANNEL,
    )).toBeUndefined();
  });

  it('counts records for the channel (1-based; first demotion is epoch 1)', () => {
    const records = [
      epoch(PROJECT_CHANNEL, '2026-01-01T00:00:00.000Z'),
      epoch(PROJECT_CHANNEL, '2026-03-01T00:00:00.000Z'),
      epoch(LOBBY_CHANNEL, '2026-02-01T00:00:00.000Z'),
    ];
    expect(deriveChannelClassificationEpoch(records, PROJECT_CHANNEL)).toBe(2);
    expect(deriveChannelClassificationEpoch(records, LOBBY_CHANNEL)).toBe(1);
  });

  it('honors the as-of boundary at `at` (formation instant)', () => {
    const records = [
      epoch(PROJECT_CHANNEL, '2026-01-01T00:00:00.000Z'),
      epoch(PROJECT_CHANNEL, '2026-03-01T00:00:00.000Z'),
    ];
    // Before the first boundary → untracked.
    expect(deriveChannelClassificationEpoch(records, PROJECT_CHANNEL, new Date('2025-12-31T00:00:00.000Z')))
      .toBeUndefined();
    // Between boundaries → epoch 1.
    expect(deriveChannelClassificationEpoch(records, PROJECT_CHANNEL, new Date('2026-02-01T00:00:00.000Z')))
      .toBe(1);
    // After both → epoch 2.
    expect(deriveChannelClassificationEpoch(records, PROJECT_CHANNEL, new Date('2026-04-01T00:00:00.000Z')))
      .toBe(2);
  });

  it('fails closed to undefined for a blank channel id or an unusable boundary', () => {
    const records = [epoch(PROJECT_CHANNEL, '2026-01-01T00:00:00.000Z')];
    expect(deriveChannelClassificationEpoch(records, '   ')).toBeUndefined();
    expect(deriveChannelClassificationEpoch(records, PROJECT_CHANNEL, new Date(NaN))).toBeUndefined();
  });
});

describe('classification-epoch enforcement end-to-end through production composition', () => {
  it('denies pre-demotion content and flows post-acceptance content, byte-identical when untracked', () => {
    const root = makeRoot({ [PROJECT_CHANNEL]: { privacy: 'invite_only' } });
    const service = buildService(root);

    // ── Pre-demotion: no epoch records → byte-identical to the pre-epoch runtime.
    hydrateFromOwnerFiles(root);
    expect(currentChannelClassificationEpoch(PROJECT_CHANNEL)).toBeUndefined();

    const preDemotionDestination = deriveDisclosureDestination({
      method: 'discord.send',
      params: { channelId: PROJECT_CHANNEL },
      resolveChannel: resolveEgressChannel,
    });
    // An untracked channel carries NO currentEpoch, so jp36.6.3's gate stays inert.
    expect(preDemotionDestination).toEqual({ kind: 'invite_only_room', channelId: PROJECT_CHANNEL });

    // ── Operator demotes invite_only → public through the real Garden flow.
    const accepted = service.acceptChannelDemotion({
      channelId: PROJECT_CHANNEL,
      acknowledgedNoticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
      actor: 'operator:test',
    });
    expect(accepted.ok).toBe(true);
    const epochAtMs = Date.parse(accepted.epoch!.at);

    // Runtime re-hydrates from the owner file the demotion just wrote.
    hydrateFromOwnerFiles(root);
    expect(currentChannelClassificationEpoch(PROJECT_CHANNEL)).toBe(1);

    // The egress destination now carries the current epoch (1).
    const destination = deriveDisclosureDestination({
      method: 'discord.send',
      params: { channelId: PROJECT_CHANNEL },
      resolveChannel: resolveEgressChannel,
    });
    expect(destination).toEqual({ kind: 'public_room', channelId: PROJECT_CHANNEL, currentEpoch: 1 });

    // A turn in the now-public room; its own session content is admitted at epoch 1.
    const scope = createGroupConversationScope({ channelId: PROJECT_CHANNEL, envelope: PUBLIC_ENVELOPE });

    // Content admitted PRE-demotion (memory formed before the epoch boundary):
    // carries no formation-time epoch → UNKNOWN admitted epoch → approval_required.
    const preContentLineage = buildGenerationDisclosureLineage({
      context: CONTEXT,
      conversationScope: scope,
      conversationChannelEpoch: currentChannelClassificationEpoch(PROJECT_CHANNEL),
      memorySources: [memorySource({
        id: 'pre',
        sourceChannelId: PROJECT_CHANNEL,
        sensitivity: 'public',
        extractedAt: epochAtMs - 60_000,
      })],
    });
    const preVerdict = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage: preContentLineage,
      destination,
    });
    expect(preVerdict.allowed).toBe(false);
    expect(preVerdict.outcome).toBe('approval_required');

    // Content admitted POST-acceptance (memory formed after the boundary):
    // carries formation-time epoch 1 → matches the room's current epoch → flows.
    const postContentLineage = buildGenerationDisclosureLineage({
      context: CONTEXT,
      conversationScope: scope,
      conversationChannelEpoch: currentChannelClassificationEpoch(PROJECT_CHANNEL),
      memorySources: [memorySource({
        id: 'post',
        sourceChannelId: PROJECT_CHANNEL,
        sensitivity: 'public',
        extractedAt: epochAtMs + 60_000,
      })],
    });
    const postVerdict = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage: postContentLineage,
      destination,
    });
    expect(postVerdict.allowed).toBe(true);
    expect(postVerdict.outcome).toBe('auto_shareable');
  });

  it('is byte-identical for a public channel that was never demoted (no epoch records)', () => {
    const root = makeRoot({
      [LOBBY_CHANNEL]: { privacy: 'public' },
    });
    hydrateFromOwnerFiles(root);

    expect(currentChannelClassificationEpoch(LOBBY_CHANNEL)).toBeUndefined();

    const destination = deriveDisclosureDestination({
      method: 'discord.send',
      params: { channelId: LOBBY_CHANNEL },
      resolveChannel: resolveEgressChannel,
    });
    // No currentEpoch stamped → the epoch gate is skipped entirely.
    expect(destination).toEqual({ kind: 'public_room', channelId: LOBBY_CHANNEL });
    expect(destination && 'currentEpoch' in destination).toBe(false);

    const scope = createGroupConversationScope({ channelId: LOBBY_CHANNEL, envelope: PUBLIC_ENVELOPE });
    const lineage = buildGenerationDisclosureLineage({
      context: CONTEXT,
      conversationScope: scope,
      conversationChannelEpoch: currentChannelClassificationEpoch(LOBBY_CHANNEL),
      memorySources: [memorySource({
        id: 'lobby',
        sourceChannelId: LOBBY_CHANNEL,
        sensitivity: 'public',
        extractedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      })],
    });
    const verdict = composeEgressDisclosureDecision({ sinkAllowed: true, lineage, destination });
    expect(verdict.allowed).toBe(true);
    expect(verdict.outcome).toBe('auto_shareable');
  });

  it('keeps a pre-demotion invite-only send epoch-inert (byte-identical baseline)', () => {
    const root = makeRoot({ [PROJECT_CHANNEL]: { privacy: 'invite_only' } });
    hydrateFromOwnerFiles(root);

    const destination = deriveDisclosureDestination({
      method: 'discord.send',
      params: { channelId: PROJECT_CHANNEL },
      resolveChannel: resolveEgressChannel,
    });
    const scope = createGroupConversationScope({ channelId: PROJECT_CHANNEL, envelope: INVITE_ENVELOPE });
    const lineage = buildGenerationDisclosureLineage({
      context: CONTEXT,
      conversationScope: scope,
      conversationChannelEpoch: currentChannelClassificationEpoch(PROJECT_CHANNEL),
      memorySources: [memorySource({
        id: 'invite',
        sourceChannelId: PROJECT_CHANNEL,
        sensitivity: 'personal',
        extractedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      })],
    });
    const verdict = composeEgressDisclosureDecision({ sinkAllowed: true, lineage, destination });
    expect(destination && 'currentEpoch' in destination).toBe(false);
    expect(verdict.allowed).toBe(true);
    expect(verdict.outcome).toBe('auto_shareable');
  });
});
