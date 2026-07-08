// E3.2 — channel-envelope migration support tests against synthetic stores
// (temp-dir session journals, synthetic contact rows, temp-dir owner file).

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyChannelEnvelopeMigrationPlan,
  collectSessionChannelObservations,
  formatChannelEnvelopeMigrationReport,
  loadExistingChannelEnvelopeLabels,
  observationsFromContactActivityRows,
} from './channel-envelope-migration-support.js';
import { planChannelEnvelopeMigration } from '../../system/trust/channel-envelope-migration.js';
import { getDefaultTrustPolicy } from '../../system/trust/runtime-policy.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-channel-envelope-migration-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeJsonl(dir: string, file: string, lines: unknown[]): void {
  writeFileSync(
    join(dir, file),
    `${lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`,
  );
}

describe('collectSessionChannelObservations', () => {
  it('enumerates channel ids with decoded visibility stamps and reports skipped lines', () => {
    const sessionsDir = makeTempDir();
    writeJsonl(sessionsDir, '20260101_room_townsquare_000001.jsonl', [
      { type: 'message', id: 1, channelId: 'room:townsquare', channelVisibility: 'invite_only', timestamp: 1 },
      { type: 'message', id: 2, channelId: 'room:townsquare', channelVisibility: 'semi_private', timestamp: 2 },
      { type: 'message', id: 3, channelId: 'dm:alice', channelVisibility: 'private', timestamp: 3 },
      { type: 'marker', id: 4, channelId: 'dm:alice', timestamp: 4 },
      'not-json{{{',
      { type: 'message', id: 5, timestamp: 5 },
    ]);
    writeFileSync(join(sessionsDir, 'ignored.txt'), 'not a journal');

    const result = collectSessionChannelObservations(sessionsDir);
    expect(result.scannedFiles).toBe(1);
    expect(result.skippedLines).toBe(2);
    expect(result.undecodableVisibilityStamps).toBe(0);

    const townsquare = result.observations.find(entry => entry.channelId === 'room:townsquare');
    // Legacy 'semi_private' stamps decode to 'invite_only' at the read boundary.
    expect(townsquare?.storedVisibilities).toEqual(['invite_only', 'invite_only']);
    const dm = result.observations.find(entry => entry.channelId === 'dm:alice');
    expect(dm?.storedVisibilities).toEqual(['private']);
    expect(dm?.sources).toEqual(['session_journal']);
  });

  it('counts undecodable visibility stamps instead of guessing', () => {
    const sessionsDir = makeTempDir();
    writeJsonl(sessionsDir, '20260101_room_x_000001.jsonl', [
      { type: 'message', id: 1, channelId: 'room:x', channelVisibility: 'mystery_level', timestamp: 1 },
    ]);
    const result = collectSessionChannelObservations(sessionsDir);
    expect(result.undecodableVisibilityStamps).toBe(1);
    expect(result.observations[0]?.storedVisibilities).toEqual([]);
  });

  it('returns an empty scan for a missing sessions directory', () => {
    const result = collectSessionChannelObservations(join(makeTempDir(), 'missing'));
    expect(result.observations).toEqual([]);
    expect(result.scannedFiles).toBe(0);
  });
});

describe('observationsFromContactActivityRows', () => {
  it('maps rows to observations, decoding legacy stamps and reporting bad rows', () => {
    const result = observationsFromContactActivityRows([
      { channelId: 'room:friends', privacyLevel: 'semi_private' },
      { channelId: 'room:friends', privacyLevel: 'invite_only' },
      { channelId: 'dm:bob', privacyLevel: 'private' },
      { channelId: 'room:quiet', privacyLevel: null },
      { channelId: '', privacyLevel: 'public' },
      { channelId: 42, privacyLevel: 'public' },
      { channelId: 'room:odd', privacyLevel: 'not-a-level' },
    ]);

    expect(result.scannedRows).toBe(7);
    expect(result.skippedRows).toBe(2);
    expect(result.undecodableVisibilityStamps).toBe(1);

    const friends = result.observations.find(entry => entry.channelId === 'room:friends');
    expect(friends?.storedVisibilities).toEqual(['invite_only', 'invite_only']);
    expect(friends?.sources).toEqual(['contact_channel_activity']);
    const quiet = result.observations.find(entry => entry.channelId === 'room:quiet');
    expect(quiet?.storedVisibilities).toEqual([]);
  });
});

describe('applyChannelEnvelopeMigrationPlan', () => {
  it('runs the full synthetic-store flow: enumerate -> plan -> apply -> reload', () => {
    const systemDataDir = makeTempDir();
    const sessionsDir = join(makeTempDir(), 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeJsonl(sessionsDir, '20260101_mixed_000001.jsonl', [
      { type: 'message', id: 1, channelId: 'twitter:main', timestamp: 1 },
      { type: 'message', id: 2, channelId: 'room:friends', channelVisibility: 'invite_only', timestamp: 2 },
      { type: 'message', id: 3, channelId: 'room:mystery', timestamp: 3 },
    ]);
    writeFileSync(join(systemDataDir, 'channels.json'), JSON.stringify({
      telegram: { enabled: false },
      contextEnvelope: {
        channels: {
          'room:already-labeled': { privacy: 'private' },
        },
      },
    }, null, 2));

    const sessionScan = collectSessionChannelObservations(sessionsDir);
    const contactScan = observationsFromContactActivityRows([
      { channelId: 'dm:bob', privacyLevel: 'private' },
      { channelId: 'room:already-labeled', privacyLevel: 'public' },
    ]);

    const plan = planChannelEnvelopeMigration({
      observations: [...sessionScan.observations, ...contactScan.observations],
      trustPolicy: getDefaultTrustPolicy(),
      existingLabels: loadExistingChannelEnvelopeLabels(systemDataDir),
    });

    expect(plan.counts).toEqual({
      skip_existing_label: 1,
      skip_operator_override: 0,
      seed: 3,
      seed_ambiguous: 1,
    });

    const report = formatChannelEnvelopeMigrationReport(plan, { dryRun: true, sessionScan, contactScan });
    expect(report.join('\n')).toContain('room:mystery');
    expect(report.join('\n')).toContain('[NEEDS REVIEW]');

    const applied = applyChannelEnvelopeMigrationPlan(systemDataDir, plan);
    expect(applied.writtenChannelIds.sort()).toEqual([
      'dm:bob',
      'room:friends',
      'room:mystery',
      'twitter:main',
    ]);

    const written = JSON.parse(readFileSync(join(systemDataDir, 'channels.json'), 'utf8'));
    // Untouched sections survive.
    expect(written.telegram).toEqual({ enabled: false });
    expect(written.contextEnvelope.channels).toEqual({
      'room:already-labeled': { privacy: 'private' },
      'dm:bob': { privacy: 'private' },
      'room:friends': { privacy: 'invite_only' },
      'room:mystery': { privacy: 'invite_only', needsReview: true },
      'twitter:main': { privacy: 'public', broadcast: true },
    });

    // The written file loads through the fail-closed owner-file parser.
    const reloaded = loadExistingChannelEnvelopeLabels(systemDataDir);
    expect(reloaded['twitter:main']).toEqual({ privacy: 'public', broadcast: true });
    expect(reloaded['room:mystery']).toEqual({ privacy: 'invite_only', needsReview: true });
  });

  it('refuses to overwrite a label that appeared after planning', () => {
    const systemDataDir = makeTempDir();
    writeFileSync(join(systemDataDir, 'channels.json'), JSON.stringify({ contextEnvelope: { channels: {} } }));

    const plan = planChannelEnvelopeMigration({
      observations: [{ channelId: 'room:new', storedVisibilities: ['public'], sources: ['test'] }],
      trustPolicy: getDefaultTrustPolicy(),
      existingLabels: loadExistingChannelEnvelopeLabels(systemDataDir),
    });

    // Simulate a concurrent operator edit between plan and apply.
    writeFileSync(join(systemDataDir, 'channels.json'), JSON.stringify({
      contextEnvelope: { channels: { 'room:new': { privacy: 'private' } } },
    }));

    expect(() => applyChannelEnvelopeMigrationPlan(systemDataDir, plan)).toThrow(/refuses to overwrite/);
  });

  it('writes into the channels wrapper scope when the owner file uses one', () => {
    const systemDataDir = makeTempDir();
    writeFileSync(join(systemDataDir, 'channels.json'), JSON.stringify({
      channels: {
        telegram: { enabled: false },
      },
    }));

    const plan = planChannelEnvelopeMigration({
      observations: [{ channelId: 'dm:carol', storedVisibilities: ['private'], sources: ['test'] }],
      trustPolicy: getDefaultTrustPolicy(),
      existingLabels: loadExistingChannelEnvelopeLabels(systemDataDir),
    });
    applyChannelEnvelopeMigrationPlan(systemDataDir, plan);

    const written = JSON.parse(readFileSync(join(systemDataDir, 'channels.json'), 'utf8'));
    expect(written.channels.contextEnvelope.channels['dm:carol']).toEqual({ privacy: 'private' });
    expect(written.channels.telegram).toEqual({ enabled: false });
    expect(loadExistingChannelEnvelopeLabels(systemDataDir)['dm:carol']).toEqual({ privacy: 'private' });
  });
});
