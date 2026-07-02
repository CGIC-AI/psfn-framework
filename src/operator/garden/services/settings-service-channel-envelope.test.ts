// E3.2 — Garden channel Context Envelope view/edit tests (owner-file path).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnerFileConfigStore } from '../../../system/config/config-store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
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

    expect(data.prefixOverrides).toEqual({ 'ops:': 'private' });
    expect(data.broadcastPrefixes).toContain('twitter:');
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
