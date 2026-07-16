import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import { DiscordEvidenceLifecycleEventSource } from '../../channels/discord/evidence-lifecycle-events.js';
import { DiscordEvidenceLifecycleCoordinator } from './discord-evidence-lifecycle.js';

const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const COMPANION_A = '22222222-2222-4222-8222-222222222222';
const COMPANION_B = '33333333-3333-4333-8333-333333333333';
const SUBJECT_ID = '100000000000000001';
const OTHER_SUBJECT_ID = '100000000000000011';
const GUILD_ID = '100000000000000002';
const CHANNEL_A = '100000000000000003';
const CHANNEL_B = '100000000000000004';
const ROLE_ID = '100000000000000005';

function config(): FleetAuthConfig {
  const credential = (envName: string) => ({ kind: 'env' as const, envName });
  return {
    schemaVersion: 1,
    activationGeneration: 4,
    canonicalOrigin: 'https://fleet.example.test',
    callbackPath: '/auth/discord/callback',
    provider: {
      kind: 'discord',
      clientId: '100000000000000010',
      scopes: ['identify', 'guilds', 'guilds.members.read'],
      clientSecretRef: credential('FLEET_AUTH_DISCORD_CLIENT_SECRET'),
      tokenCustody: 'discard',
    },
    credentials: {
      tokenEncryptionKeyRef: credential('FLEET_AUTH_TOKEN_ENCRYPTION_KEY'),
      sessionPepperRef: credential('FLEET_AUTH_SESSION_PEPPER'),
      assertionPrivateKeyRef: credential('FLEET_AUTH_ASSERTION_PRIVATE_KEY'),
      trustedHostRecoveryCredentialRef: credential('FLEET_AUTH_RECOVERY_CREDENTIAL'),
      runtimeDatabaseUrlRef: credential('FLEET_AUTH_RUNTIME_DATABASE_URL'),
      migrationDatabaseUrlRef: credential('FLEET_AUTH_MIGRATION_DATABASE_URL'),
      backupRestoreDatabaseUrlRef: credential('FLEET_AUTH_BACKUP_DATABASE_URL'),
      authorityFloorRootRef: credential('FLEET_AUTH_AUTHORITY_FLOOR_ROOT'),
    },
    databaseRoles: {
      runtime: 'fleet_auth_runtime',
      migration: 'fleet_auth_migration',
      backupRestore: 'fleet_auth_backup',
    },
    verifierKeys: [],
    hubDeviceAssertions: {
      issuer: 'psfn-satellite-hub',
      audience: 'https://fleet.example.test',
      maxTtlSeconds: 60,
      clockSkewSeconds: 2,
      keys: [],
    },
    ttls: {
      oauthTransactionMs: 300_000,
      sessionIdleMs: 1_800_000,
      sessionAbsoluteMs: 28_800_000,
      discordEvidenceMs: 300_000,
      jitGrantMs: 300_000,
      stepUpChallengeMs: 180_000,
      internalAssertionMs: 30_000,
    },
    rolePolicy: { disabledActionsByRole: { owner: [], admin: [], member: [], guest: [] } },
    discordEvidenceMappings: [
      { companionId: COMPANION_A, guildId: GUILD_ID, channelId: CHANNEL_A, requiredRoleIds: [] },
      { companionId: COMPANION_B, guildId: GUILD_ID, channelId: CHANNEL_B, requiredRoleIds: [] },
    ],
  };
}

function membership(observedAt: Date) {
  return {
    status: 'observed',
    providerSubjectId: SUBJECT_ID,
    observedAt: observedAt.toISOString(),
    guilds: [{ guildId: GUILD_ID, roleIds: [ROLE_ID] }],
  };
}

describe('Discord evidence production lifecycle', () => {
  it('recovers a pre-ready login through the real ready/change hooks and isolates companions', async () => {
    let now = new Date('2026-07-16T12:00:00.000Z');
    const runtime = {
      refreshPrincipalEvidence: vi.fn(async () => []),
      refreshCompanionEvidence: vi.fn(async () => []),
    };
    const store = {
      revokeAllEvidence: vi.fn(async () => undefined),
      revokePrincipalEvidence: vi.fn(async () => undefined),
    };
    const coordinator = new DiscordEvidenceLifecycleCoordinator({
      config: config(),
      runtime,
      store,
      now: () => now,
      setTimer: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
    });
    await coordinator.start();
    expect(store.revokeAllEvidence).toHaveBeenCalledOnce();

    await coordinator.recordActiveOAuthSession({
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      providerMembershipEvidence: membership(now),
      idleExpiresAt: new Date('2026-07-16T12:30:00.000Z'),
      absoluteExpiresAt: new Date('2026-07-16T20:00:00.000Z'),
    });
    expect(coordinator.retainedMembershipEvidenceCount()).toBe(1);
    expect(JSON.stringify(runtime.refreshPrincipalEvidence.mock.calls[0])).not.toMatch(/token|secret/iu);

    const discordClient = new EventEmitter() as Client;
    const source = new DiscordEvidenceLifecycleEventSource(discordClient);
    source.attach();
    coordinator.registerCompanionEventSource(COMPANION_A, source);
    discordClient.emit(Events.ClientReady, {});
    await coordinator.drain();
    expect(store.revokePrincipalEvidence).toHaveBeenLastCalledWith({
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      companionId: COMPANION_A,
    });
    expect(runtime.refreshCompanionEvidence).toHaveBeenLastCalledWith(expect.objectContaining({
      companionId: COMPANION_A,
      providerSubjectId: SUBJECT_ID,
    }));

    const beforeOtherMember = runtime.refreshCompanionEvidence.mock.calls.length;
    discordClient.emit(Events.GuildMemberUpdate, {}, {
      id: OTHER_SUBJECT_ID,
      guild: { id: GUILD_ID },
    });
    await coordinator.drain();
    expect(runtime.refreshCompanionEvidence).toHaveBeenCalledTimes(beforeOtherMember);

    discordClient.emit(Events.GuildRoleUpdate, {}, { guild: { id: GUILD_ID } });
    await coordinator.drain();
    expect(runtime.refreshCompanionEvidence).toHaveBeenLastCalledWith(expect.objectContaining({
      companionId: COMPANION_A,
    }));
    expect(runtime.refreshCompanionEvidence.mock.calls.some(([input]) => (
      input.companionId === COMPANION_B
    ))).toBe(false);

    now = new Date('2026-07-16T12:05:00.000Z');
    await coordinator.handleAuthorityChange(COMPANION_A, { kind: 'ready' });
    expect(coordinator.reauthenticationReason(PRINCIPAL_ID, SUBJECT_ID)).toBe('evidence_expired');
    expect(coordinator.retainedMembershipEvidenceCount()).toBe(0);
    source.close();
    await coordinator.close();
  });

  it('schedules one bounded recomputation then revokes at the unchanged provider deadline', async () => {
    let now = new Date('2026-07-16T12:00:00.000Z');
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const runtime = {
      refreshPrincipalEvidence: vi.fn(async () => []),
      refreshCompanionEvidence: vi.fn(async () => []),
    };
    const store = {
      revokeAllEvidence: vi.fn(async () => undefined),
      revokePrincipalEvidence: vi.fn(async () => undefined),
    };
    const coordinator = new DiscordEvidenceLifecycleCoordinator({
      config: config(),
      runtime,
      store,
      now: () => now,
      setTimer: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
    });
    await coordinator.start();
    await coordinator.recordActiveOAuthSession({
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      providerMembershipEvidence: membership(now),
      idleExpiresAt: new Date('2026-07-16T12:30:00.000Z'),
      absoluteExpiresAt: new Date('2026-07-16T20:00:00.000Z'),
    });
    expect(timers[0]?.delayMs).toBe(225_000);

    now = new Date('2026-07-16T12:03:45.000Z');
    timers[0]?.callback();
    await coordinator.drain();
    expect(runtime.refreshPrincipalEvidence).toHaveBeenCalledTimes(2);
    expect(timers[1]?.delayMs).toBe(75_000);
    const renewalEvidence = runtime.refreshPrincipalEvidence.mock.calls[1]?.[0]
      .providerMembershipEvidence as { observedAt: string };
    expect(renewalEvidence.observedAt).toBe('2026-07-16T12:00:00.000Z');

    now = new Date('2026-07-16T12:05:00.000Z');
    timers[1]?.callback();
    await coordinator.drain();
    expect(store.revokePrincipalEvidence).toHaveBeenLastCalledWith({
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
    });
    expect(coordinator.reauthenticationReason(PRINCIPAL_ID, SUBJECT_ID)).toBe('evidence_expired');
    await coordinator.close();
  });
});
