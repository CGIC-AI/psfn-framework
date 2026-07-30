import { describe, expect, it, vi } from 'vitest';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import { DiscordEvidenceLifecycleCoordinator } from './discord-evidence-lifecycle.js';
import type {
  DiscordEvidenceLifecycleMutationOutcome,
  DiscordEvidenceRefreshOutcome,
} from './discord-evidence-types.js';

const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const COMPANION_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '100000000000000001';
const GUILD_ID = '100000000000000002';

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
      escalationGrantMs: 900_000,
      internalAssertionMs: 30_000,
    },
    rolePolicy: { disabledActionsByRole: { owner: [], admin: [], member: [], guest: [] } },
    discordEvidenceMappings: [{
      companionId: COMPANION_ID,
      guildId: GUILD_ID,
      channelId: '100000000000000003',
      requiredRoleIds: [],
    }],
  };
}

const appliedRefresh = async () => ({ status: 'applied' as const, snapshots: [] });
const appliedMutation = async () => ({ status: 'applied' as const });

function harness(input: {
  refreshPrincipalEvidence?: () => Promise<DiscordEvidenceRefreshOutcome>;
  invalidatePrincipalEvidence?: () => Promise<DiscordEvidenceLifecycleMutationOutcome>;
} = {}) {
  let now = new Date('2026-07-16T12:00:00.000Z');
  const timers: Array<() => void> = [];
  const backgroundErrors = vi.fn();
  const clearTimer = vi.fn();
  const runtime = {
    refreshPrincipalEvidence: vi.fn(input.refreshPrincipalEvidence ?? appliedRefresh),
    refreshCompanionEvidence: vi.fn(appliedRefresh),
  };
  const store = {
    activatePrincipalEvidenceLifecycle: vi.fn(async () => undefined),
    invalidatePrincipalEvidence: vi.fn(input.invalidatePrincipalEvidence ?? appliedMutation),
    revokeAllEvidence: vi.fn(async () => undefined),
    revokePrincipalEvidence: vi.fn(appliedMutation),
  };
  const coordinator = new DiscordEvidenceLifecycleCoordinator({
    config: config(),
    runtime,
    store,
    sessionAuthority: {
      fencePrincipalSessionsForDiscordReauthentication: vi.fn(async () => undefined),
      fenceAllSessionsForDiscordReauthentication: vi.fn(async () => undefined),
    },
    now: () => now,
    setTimer: callback => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer,
    onBackgroundError: backgroundErrors,
  });
  return {
    backgroundErrors,
    clearTimer,
    coordinator,
    runtime,
    store,
    timers,
    setNow: (value: Date) => { now = value; },
  };
}

async function admit(subject: ReturnType<typeof harness>): Promise<void> {
  await subject.coordinator.start();
  await subject.coordinator.recordActiveOAuthSession({
    principalId: PRINCIPAL_ID,
    providerSubjectId: SUBJECT_ID,
    providerMembershipEvidence: {
      status: 'observed',
      providerSubjectId: SUBJECT_ID,
      observedAt: '2026-07-16T12:00:00.000Z',
      guilds: [{ guildId: GUILD_ID, roleIds: [] }],
    },
    idleExpiresAt: new Date('2026-07-16T12:30:00.000Z'),
    absoluteExpiresAt: new Date('2026-07-16T20:00:00.000Z'),
  });
}

describe('Discord evidence terminal authority', () => {
  it('retires exact local ownership when an event mutation reaches a terminal fence', async () => {
    const subject = harness({
      invalidatePrincipalEvidence: async () => ({ status: 'retired' }),
    });
    await admit(subject);
    const staleTimer = subject.timers[0]!;

    await subject.coordinator.handleAuthorityChange(COMPANION_ID, { kind: 'ready' });
    staleTimer();
    await subject.coordinator.drain();
    await subject.coordinator.handleAuthorityChange(COMPANION_ID, { kind: 'ready' });

    expect(subject.store.invalidatePrincipalEvidence).toHaveBeenCalledOnce();
    expect(subject.runtime.refreshPrincipalEvidence).toHaveBeenCalledOnce();
    expect(subject.runtime.refreshCompanionEvidence).not.toHaveBeenCalled();
    expect(subject.clearTimer).toHaveBeenCalledOnce();
    expect(subject.backgroundErrors).not.toHaveBeenCalled();
    expect(subject.coordinator.retainedMembershipEvidenceCount()).toBe(0);
    await subject.coordinator.close();
  });

  it('treats terminal renewal ownership loss and its stale callbacks as no-ops', async () => {
    const refreshPrincipalEvidence = vi.fn()
      .mockResolvedValueOnce({ status: 'applied' as const, snapshots: [] })
      .mockResolvedValueOnce({ status: 'retired' as const });
    const subject = harness({ refreshPrincipalEvidence });
    await admit(subject);
    const renewalTimer = subject.timers[0]!;

    subject.setNow(new Date('2026-07-16T12:03:45.000Z'));
    renewalTimer();
    await subject.coordinator.drain();
    renewalTimer();
    await subject.coordinator.drain();
    await subject.coordinator.handleAuthorityChange(COMPANION_ID, { kind: 'ready' });

    expect(refreshPrincipalEvidence).toHaveBeenCalledTimes(2);
    expect(subject.store.invalidatePrincipalEvidence).not.toHaveBeenCalled();
    expect(subject.backgroundErrors).not.toHaveBeenCalled();
    expect(subject.coordinator.retainedMembershipEvidenceCount()).toBe(0);
    await subject.coordinator.close();
  });

  it('serializes global retirement ahead of queued renewal and event work', async () => {
    const subject = harness();
    await admit(subject);
    const renewalTimer = subject.timers[0]!;

    const reset = vi.fn(async () => undefined);
    const retirement = subject.coordinator.commitGlobalAuthorityReset(reset);
    renewalTimer();
    const event = subject.coordinator.handleAuthorityChange(COMPANION_ID, { kind: 'ready' });
    await Promise.all([retirement, event]);
    await subject.coordinator.commitGlobalAuthorityReset(async () => undefined);
    renewalTimer();
    await subject.coordinator.drain();

    expect(subject.runtime.refreshPrincipalEvidence).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(subject.store.invalidatePrincipalEvidence).not.toHaveBeenCalled();
    expect(subject.clearTimer).toHaveBeenCalledOnce();
    expect(subject.backgroundErrors).not.toHaveBeenCalled();
    expect(subject.coordinator.retainedMembershipEvidenceCount()).toBe(0);
    await subject.coordinator.close();
  });

  it('keeps lifecycle ownership live when a serialized global reset rolls back', async () => {
    const subject = harness();
    await admit(subject);
    const renewalTimer = subject.timers[0]!;

    await expect(subject.coordinator.commitGlobalAuthorityReset(async () => {
      throw new Error('global reset rolled back');
    })).rejects.toThrow('global reset rolled back');
    expect(subject.coordinator.retainedMembershipEvidenceCount()).toBe(1);
    expect(subject.clearTimer).not.toHaveBeenCalled();

    subject.setNow(new Date('2026-07-16T12:03:45.000Z'));
    renewalTimer();
    await subject.coordinator.drain();
    expect(subject.runtime.refreshPrincipalEvidence).toHaveBeenCalledTimes(2);
    expect(subject.coordinator.retainedMembershipEvidenceCount()).toBe(1);
    await subject.coordinator.close();
  });

  it('keeps unexpected mutation failures fatal after terminal cleanup', async () => {
    const unexpected = new Error('unexpected persistence failure');
    const subject = harness({
      invalidatePrincipalEvidence: async () => { throw unexpected; },
    });
    await admit(subject);

    await expect(subject.coordinator.handleAuthorityChange(
      COMPANION_ID,
      { kind: 'ready' },
    )).rejects.toBe(unexpected);
    await expect(subject.coordinator.handleAuthorityChange(
      COMPANION_ID,
      { kind: 'ready' },
    )).resolves.toBeUndefined();

    expect(subject.store.revokePrincipalEvidence).toHaveBeenCalledOnce();
    expect(subject.coordinator.retainedMembershipEvidenceCount()).toBe(0);
    await subject.coordinator.close();
  });
});
