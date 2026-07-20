// E3.2 — Garden channel Context Envelope view/edit tests (owner-file path).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnerFileConfigStore } from '../../../system/config/config-store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  DEMOTION_EPOCH_NOTICE,
  DEMOTION_EPOCH_NOTICE_VERSION,
} from '../../../system/trust/context-envelope.js';
import { AdminSettingsDataService } from './settings-service.js';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-channel-envelope-service-'));
  writeFileSync(
    join(tempDir, 'trust-policy.json'),
    readFileSync(join(process.cwd(), 'config', 'trust-policy.seed.json'), 'utf8'),
    'utf8',
  );
  return tempDir;
}

function buildService(root: string): AdminSettingsDataService {
  const config = {
    dataDir: root,
    defaultContextWindow: 128_000,
  } as unknown as SubstrateConfig;
  return new AdminSettingsDataService({
    config,
    configStore: createOwnerFileConfigStore({
      dataDir: root,
      defaultContextWindow: 128_000,
    }),
  });
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('AdminSettingsDataService channel envelope surface', () => {
  it('lists labeled channels and exact operator overrides with envelope columns and source tiers', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'channels.json'), JSON.stringify({
      contextEnvelope: {
        channels: {
          'discord:friends-room': { privacy: 'invite_only', contactTracking: 'approval' },
          'social:announcements': { privacy: 'public', broadcast: true },
          'room:mystery': { privacy: 'invite_only', needsReview: true },
        },
      },
    }, null, 2));
    const trustPolicy = JSON.parse(readFileSync(join(root, 'trust-policy.json'), 'utf8'));
    trustPolicy.channelClassification.visibilityOverrides = {
      exact: { 'room:operator-owned': 'public' },
      prefix: { 'ops:': 'private' },
    };
    writeFileSync(join(root, 'trust-policy.json'), JSON.stringify(trustPolicy, null, 2));

    const data = buildService(root).getChannelEnvelopeData();
    expect(data.channels.map(row => row.channelId)).toEqual([
      'discord:friends-room',
      'room:mystery',
      'room:operator-owned',
      'social:announcements',
    ]);

    const friends = data.channels[0];
    expect(friends).toMatchObject({
      privacy: 'invite_only',
      broadcast: false,
      contactTracking: 'approval',
      source: 'channel_label',
      needsReview: false,
      hasLabel: true,
    });

    const mystery = data.channels[1];
    expect(mystery).toMatchObject({ needsReview: true, privacy: 'invite_only', source: 'channel_label' });

    const operatorOwned = data.channels[2];
    expect(operatorOwned).toMatchObject({
      privacy: 'public',
      broadcast: false,
      source: 'operator_override',
      hasLabel: false,
    });

    const announcements = data.channels[3];
    expect(announcements).toMatchObject({ privacy: 'public', broadcast: true, source: 'channel_label' });

    expect(data.prefixOverrides).toEqual({ 'ops:': { privacy: 'private', broadcast: false } });
    expect(data.broadcastPrefixes).toContain('twitter:');
  });

  it('write-gates operator_confirmed: the label editor cannot set it (jp36.6.2)', () => {
    const root = makeTempDir();
    const service = buildService(root);

    // jp36.6.1 review gate: the operator_confirmed marker must NOT be settable
    // through the generic label editor — only the click-to-accept demotion flow.
    const rejected = service.saveChannelEnvelopeLabel('room:confirmed', {
      privacy: 'public',
      classificationSource: 'operator_confirmed',
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toMatch(/classificationSource/);
    expect(rejected.message).toMatch(/demotion flow/);

    // Nothing was written for that channel.
    const data = service.getChannelEnvelopeData();
    expect(data.channels.find(row => row.channelId === 'room:confirmed')).toBeUndefined();
  });

  it('blocks generic non-public → public edits and preserves prior confirmation authority', () => {
    const root = makeTempDir();
    const service = buildService(root);

    expect(service.saveChannelEnvelopeLabel('room:friends', {
      privacy: 'invite_only',
      contactTracking: 'auto',
    }).ok).toBe(true);

    const bypass = service.saveChannelEnvelopeLabel('room:friends', {
      privacy: 'public',
      contactTracking: 'auto',
    });
    expect(bypass.ok).toBe(false);
    expect(bypass.message).toMatch(/click-to-accept/i);
    expect(bypass.message).toMatch(/fresh disclosure epoch/i);

    const accepted = service.acceptChannelDemotion({
      channelId: 'room:friends',
      acknowledgedNoticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
    });
    expect(accepted.ok).toBe(true);

    const edited = service.saveChannelEnvelopeLabel('room:friends', {
      privacy: 'public',
      contactTracking: 'approval',
    });
    expect(edited.ok).toBe(true);

    const written = JSON.parse(readFileSync(join(root, 'channels.json'), 'utf8'));
    expect(written.contextEnvelope.channels['room:friends']).toEqual({
      privacy: 'public',
      contactTracking: 'approval',
      classificationSource: 'operator_confirmed',
    });
    expect(written.contextEnvelope.classificationEpochs).toHaveLength(1);
  });

  it('upserts and removes channel labels through the validated owner-file path', () => {
    const root = makeTempDir();
    const service = buildService(root);

    const saved = service.saveChannelEnvelopeLabel('room:new-place', {
      privacy: 'private',
      contactTracking: 'approval',
    });
    expect(saved.ok).toBe(true);

    const written = JSON.parse(readFileSync(join(root, 'channels.json'), 'utf8'));
    expect(written.contextEnvelope.channels['room:new-place']).toEqual({
      privacy: 'private',
      contactTracking: 'approval',
    });

    const listed = service.getChannelEnvelopeData();
    expect(listed.channels[0]).toMatchObject({
      channelId: 'room:new-place',
      privacy: 'private',
      contactTracking: 'approval',
      source: 'channel_label',
    });

    const removed = service.saveChannelEnvelopeLabel('room:new-place', null);
    expect(removed.ok).toBe(true);
    expect(service.getChannelEnvelopeData().channels).toEqual([]);
  });

  it('rejects invalid labels fail-closed without writing the owner file', () => {
    const root = makeTempDir();
    const service = buildService(root);

    // Retired vocabulary.
    const retired = service.saveChannelEnvelopeLabel('room:x', { privacy: 'semi_private' });
    expect(retired.ok).toBe(false);
    expect(retired.message).toContain('privacy');

    // Contract rule: broadcast surfaces are always public.
    const contradictory = service.saveChannelEnvelopeLabel('room:x', { privacy: 'private', broadcast: true });
    expect(contradictory.ok).toBe(false);
    expect(contradictory.message).toContain('broadcast');

    // Unknown keys fail closed.
    const unknown = service.saveChannelEnvelopeLabel('room:x', { privacy: 'public', extra: true });
    expect(unknown.ok).toBe(false);

    expect(service.getChannelEnvelopeData().channels).toEqual([]);

    // Removing a label that does not exist is an error, not a silent no-op.
    const missing = service.saveChannelEnvelopeLabel('room:x', null);
    expect(missing.ok).toBe(false);
  });

  it('preserves unrelated channels.json sections when editing labels', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'channels.json'), JSON.stringify({
      telegram: { enabled: false },
      contextEnvelope: { channels: { 'room:keep': { privacy: 'public' } } },
    }, null, 2));

    const service = buildService(root);
    const result = service.saveChannelEnvelopeLabel('room:added', { privacy: 'invite_only' });
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(join(root, 'channels.json'), 'utf8'));
    expect(written.telegram).toEqual({ enabled: false });
    expect(written.contextEnvelope.channels).toEqual({
      'room:keep': { privacy: 'public' },
      'room:added': { privacy: 'invite_only' },
    });
  });
});

describe('AdminSettingsDataService invite-only -> public demotion flow (jp36.6.2)', () => {
  it('serves the click-to-accept notice and marks an invite-only channel demotable', () => {
    const root = makeTempDir();
    const service = buildService(root);

    // Unlabeled non-DM channel resolves to the invite_only derived default.
    const notice = service.getChannelDemotionNotice('discord:group-room');
    expect(notice).toMatchObject({
      channelId: 'discord:group-room',
      currentPrivacy: 'invite_only',
      from: 'invite_only',
      to: 'public',
      demotable: true,
      noticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
    });
    // All four load-bearing statements from the bible §9.3 spec are present.
    expect(notice.notice).toBe(DEMOTION_EPOCH_NOTICE);
    expect(notice.notice).toMatch(/fresh disclosure epoch/i);
    expect(notice.notice).toMatch(/no longer be auto-shared/i);
    expect(notice.notice).toMatch(/human-in-the-loop egress review/i);
    expect(notice.notice).toMatch(/only content generated after you accept/i);
  });

  it('reports non-demotable for a channel that is already public', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'channels.json'), JSON.stringify({
      contextEnvelope: { channels: { 'room:already-public': { privacy: 'public' } } },
    }, null, 2));
    const service = buildService(root);

    const notice = service.getChannelDemotionNotice('room:already-public');
    expect(notice.demotable).toBe(false);
    expect(notice.reason).toMatch(/not invite-only/i);
  });

  it('blocks demotion without an acknowledged notice version (fail closed)', () => {
    const root = makeTempDir();
    const service = buildService(root);

    const missing = service.acceptChannelDemotion({
      channelId: 'discord:group-room',
      acknowledgedNoticeVersion: undefined,
    });
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/blocked/i);

    const wrong = service.acceptChannelDemotion({
      channelId: 'discord:group-room',
      acknowledgedNoticeVersion: 'not-the-version',
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toMatch(/blocked/i);

    // No label and no epoch were written.
    const data = service.getChannelEnvelopeData();
    expect(data.channels.find(row => row.channelId === 'discord:group-room')).toBeUndefined();
    expect(data.epochs).toEqual([]);
  });

  it('stamps operator_confirmed and records an epoch on acceptance', () => {
    const root = makeTempDir();
    const service = buildService(root);

    const before = Date.now();
    const result = service.acceptChannelDemotion({
      channelId: 'discord:group-room',
      acknowledgedNoticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
      actor: 'operator:alice',
    });
    expect(result.ok).toBe(true);
    expect(result.epoch).toMatchObject({
      channelId: 'discord:group-room',
      from: 'invite_only',
      to: 'public',
      acceptedBy: 'operator:alice',
      noticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
    });
    expect(Date.parse(result.epoch!.at)).toBeGreaterThanOrEqual(before);

    // Owner file now carries the confirmed public label AND the epoch record.
    const written = JSON.parse(readFileSync(join(root, 'channels.json'), 'utf8'));
    expect(written.contextEnvelope.channels['discord:group-room']).toEqual({
      privacy: 'public',
      classificationSource: 'operator_confirmed',
    });
    expect(written.contextEnvelope.classificationEpochs).toHaveLength(1);
    expect(written.contextEnvelope.classificationEpochs[0]).toMatchObject({
      channelId: 'discord:group-room',
      from: 'invite_only',
      to: 'public',
    });

    // The resolved row now reports the operator decision, and the epoch is queryable.
    const data = service.getChannelEnvelopeData();
    const row = data.channels.find(r => r.channelId === 'discord:group-room');
    expect(row).toMatchObject({ privacy: 'public', source: 'operator_confirmed' });
    expect(data.epochs).toHaveLength(1);
  });

  it('preserves contactTracking from the pre-demotion label and drops needsReview', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'channels.json'), JSON.stringify({
      contextEnvelope: {
        channels: {
          'room:seeded': { privacy: 'invite_only', contactTracking: 'approval', needsReview: true },
        },
      },
    }, null, 2));
    const service = buildService(root);

    const result = service.acceptChannelDemotion({
      channelId: 'room:seeded',
      acknowledgedNoticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
    });
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(join(root, 'channels.json'), 'utf8'));
    expect(written.contextEnvelope.channels['room:seeded']).toEqual({
      privacy: 'public',
      classificationSource: 'operator_confirmed',
      contactTracking: 'approval',
    });
  });

  it('rejects a hand-authored operator_confirmed label with no matching epoch (owner-file invariant)', () => {
    const root = makeTempDir();
    // Simulate a raw owner-file edit asserting confirmation without the flow.
    writeFileSync(join(root, 'channels.json'), JSON.stringify({
      contextEnvelope: {
        channels: { 'room:forged': { privacy: 'public', classificationSource: 'operator_confirmed' } },
      },
    }, null, 2));
    const service = buildService(root);

    // Any read that parses the section fails closed.
    expect(() => service.getChannelEnvelopeData()).toThrow(/matching classificationEpochs record/);
  });
});
