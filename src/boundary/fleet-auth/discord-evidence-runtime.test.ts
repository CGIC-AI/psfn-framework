import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import {
  isUsablePositiveDiscordEvidence,
  type DiscordEvidenceSnapshot,
  type DiscordEvidenceStorePort,
} from './discord-evidence-types.js';
import { DiscordEvidenceRuntime } from './discord-evidence-runtime.js';

const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const COMPANION_A = '22222222-2222-4222-8222-222222222222';
const COMPANION_B = '33333333-3333-4333-8333-333333333333';
const SUBJECT_ID = '100000000000000001';
const GUILD_ID = '100000000000000002';
const CHANNEL_A = '100000000000000003';
const CHANNEL_B = '100000000000000004';
const CHANNEL_C = '100000000000000005';
const PARENT_A = '100000000000000006';
const ROLE_A = '100000000000000007';
const ROLE_B = '100000000000000008';
const BOT_A = '100000000000000009';
const BOT_B = '100000000000000010';
const NOW = new Date('2026-07-16T12:00:00.000Z');

type Mapping = FleetAuthConfig['discordEvidenceMappings'][number];

function config(mappings: Mapping[]): FleetAuthConfig {
  const credential = (envName: string) => ({ kind: 'env' as const, envName });
  return {
    schemaVersion: 1,
    activationGeneration: 4,
    canonicalOrigin: 'https://fleet.example.test',
    callbackPath: '/auth/discord/callback',
    provider: {
      kind: 'discord',
      clientId: '100000000000000011',
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
    rolePolicy: {
      disabledActionsByRole: { owner: [], admin: [], member: [], guest: [] },
    },
    discordEvidenceMappings: mappings,
  };
}

function mapping(overrides: Partial<Mapping> = {}): Mapping {
  return {
    guildId: GUILD_ID,
    channelId: CHANNEL_A,
    companionId: COMPANION_A,
    requiredRoleIds: [],
    ...overrides,
  };
}

function overwrite(allow = 0n, deny = 0n) {
  return { allow: allow.toString(), deny: deny.toString() };
}

function currentTarget(input: {
  channelId?: string;
  kind?: 'guild_channel' | 'public_thread' | 'private_thread';
  parentChannelId?: string;
  roleIds?: string[];
  everyonePermissions?: bigint;
  rolePermissions?: Record<string, bigint>;
  everyoneOverwrite?: ReturnType<typeof overwrite> | null;
  roleOverwrites?: Array<ReturnType<typeof overwrite> & { roleId: string }>;
  memberOverwrite?: ReturnType<typeof overwrite> | null;
  threadMember?: boolean;
} = {}): Record<string, unknown> {
  const roleIds = input.roleIds ?? [ROLE_A];
  const channelId = input.channelId ?? CHANNEL_A;
  const kind = input.kind ?? 'guild_channel';
  const parentChannelId = input.parentChannelId ?? PARENT_A;
  const channel = {
    kind,
    id: channelId,
    permissionChannelId: kind === 'guild_channel' ? channelId : parentChannelId,
    ...(kind === 'guild_channel' ? {} : { parentChannelId }),
    overwritesComplete: true,
    everyoneOverwrite: input.everyoneOverwrite ?? null,
    roleOverwrites: input.roleOverwrites ?? [],
    memberOverwrite: input.memberOverwrite ?? null,
    ...(kind === 'private_thread'
      ? { threadMembershipObserved: true, threadMember: input.threadMember ?? false }
      : {}),
  };
  return {
    status: 'current',
    guildId: GUILD_ID,
    requestedChannelId: channelId,
    member: { roleIds, guildOwner: false },
    guildPermissions: {
      everyoneRoleId: GUILD_ID,
      everyonePermissions: (input.everyonePermissions ?? PermissionFlagsBits.ViewChannel).toString(),
      roles: roleIds.map(roleId => ({
        roleId,
        permissions: (input.rolePermissions?.[roleId] ?? 0n).toString(),
      })),
    },
    channel,
  };
}

function observed(targets: unknown[], input: {
  observedAt?: string;
  botUserId?: string;
} = {}) {
  return {
    status: 'observed',
    providerSubjectId: SUBJECT_ID,
    observedAt: input.observedAt ?? NOW.toISOString(),
    observationId: 'observation-1',
    botUserId: input.botUserId ?? BOT_A,
    targets,
  };
}

function providerMembership(roleIds: string[] = [ROLE_A], input: {
  observedAt?: string;
  guilds?: Array<{ guildId: string; roleIds: string[] }>;
} = {}) {
  return {
    status: 'observed',
    providerSubjectId: SUBJECT_ID,
    observedAt: input.observedAt ?? NOW.toISOString(),
    guilds: input.guilds ?? [{ guildId: GUILD_ID, roleIds }],
  };
}

class RecordingStore implements DiscordEvidenceStorePort {
  readonly replacements: DiscordEvidenceSnapshot[][] = [];
  readonly companionReplacements: string[] = [];

  async replacePrincipalEvidence(input: {
    snapshots: readonly DiscordEvidenceSnapshot[];
  }): Promise<void> {
    this.replacements.push([...input.snapshots]);
  }

  async replaceCompanionEvidence(input: {
    companionId: string;
    snapshots: readonly DiscordEvidenceSnapshot[];
  }): Promise<void> {
    this.companionReplacements.push(input.companionId);
    this.replacements.push([...input.snapshots]);
  }

  async revokePrincipalEvidence(): Promise<void> {
    await Promise.resolve();
  }

  async revokeAllEvidence(): Promise<void> {
    await Promise.resolve();
  }

  async loadUsablePositiveEvidence(): Promise<DiscordEvidenceSnapshot | undefined> {
    return undefined;
  }
}

function runtime(input: {
  mappings?: Mapping[];
  observe: (companionId: string) => unknown | Promise<unknown>;
  providerMembership?: () => unknown;
}) {
  const store = new RecordingStore();
  const observe = vi.fn(async ({ companionId }: { companionId: string }) => (
    await input.observe(companionId)
  ));
  return {
    store,
    observe,
    providerMembership: input.providerMembership ?? (() => providerMembership()),
    runtime: new DiscordEvidenceRuntime({
      config: config(input.mappings ?? [mapping()]),
      observer: { observe },
      store,
      now: () => NOW,
    }),
  };
}

async function refresh(subject: ReturnType<typeof runtime>): Promise<DiscordEvidenceSnapshot[]> {
  return await subject.runtime.refreshPrincipalEvidence({
    principalId: PRINCIPAL_ID,
    providerSubjectId: SUBJECT_ID,
    providerMembershipEvidence: subject.providerMembership(),
  });
}

describe('bounded Discord access evidence', () => {
  it('applies everyone, aggregate role, then member precedence before PSFN role narrowing', async () => {
    const roleOverwrites = [
      { roleId: ROLE_A, ...overwrite(0n, PermissionFlagsBits.ViewChannel) },
      { roleId: ROLE_B, ...overwrite(PermissionFlagsBits.ViewChannel) },
    ];
    const subject = runtime({
      mappings: [mapping({ requiredRoleIds: [ROLE_A, ROLE_B] })],
      providerMembership: () => providerMembership([ROLE_A, ROLE_B]),
      observe: () => observed([currentTarget({
        roleIds: [ROLE_A, ROLE_B],
        everyoneOverwrite: overwrite(0n, PermissionFlagsBits.ViewChannel),
        roleOverwrites,
        memberOverwrite: overwrite(PermissionFlagsBits.ViewChannel),
      })]),
    });
    const [evidence] = await refresh(subject);
    expect(evidence).toMatchObject({
      discordPermissionResult: true,
      memberSpecificDenyVeto: false,
      psfnEvidenceResult: true,
      channelId: CHANNEL_A,
      mappingConfigVersion: 4,
      provenance: {
        source: 'discord_oauth_and_bot_observation',
        botUserId: BOT_A,
        providerSubjectId: SUBJECT_ID,
      },
    });
    expect(evidence.permissionInputs).toMatchObject({
      observation: { observedAt: NOW.toISOString(), botUserId: BOT_A },
      target: { channel: { overwritesComplete: true } },
    });
    expect(evidence.inputDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.configDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.expiresAt.toISOString()).toBe('2026-07-16T12:05:00.000Z');
  });

  it('treats member VIEW_CHANNEL deny as a hard veto even for Discord ADMINISTRATOR', async () => {
    const ordinary = runtime({
      observe: () => observed([currentTarget({
        memberOverwrite: overwrite(0n, PermissionFlagsBits.ViewChannel),
      })]),
    });
    expect((await refresh(ordinary))[0]).toMatchObject({
      discordPermissionResult: false,
      memberSpecificDenyVeto: true,
      psfnEvidenceResult: false,
      decisionReason: 'member_specific_deny',
    });

    const subject = runtime({
      observe: () => observed([currentTarget({
        everyonePermissions: PermissionFlagsBits.Administrator,
        memberOverwrite: overwrite(0n, PermissionFlagsBits.ViewChannel),
      })]),
    });
    const [evidence] = await refresh(subject);
    expect(evidence).toMatchObject({
      discordPermissionResult: true,
      memberSpecificDenyVeto: true,
      psfnEvidenceResult: false,
      decisionReason: 'member_specific_deny',
    });
  });

  it('denies implicit and private-channel visibility while allowing a current role overwrite to narrow access', async () => {
    const mappings = [
      mapping({ channelId: CHANNEL_A }),
      mapping({ channelId: CHANNEL_B }),
      mapping({ channelId: CHANNEL_C, requiredRoleIds: [ROLE_A] }),
    ];
    const subject = runtime({
      mappings,
      observe: () => observed([
        currentTarget({ channelId: CHANNEL_A, everyonePermissions: 0n }),
        currentTarget({
          channelId: CHANNEL_B,
          everyoneOverwrite: overwrite(0n, PermissionFlagsBits.ViewChannel),
        }),
        currentTarget({
          channelId: CHANNEL_C,
          everyoneOverwrite: overwrite(0n, PermissionFlagsBits.ViewChannel),
          roleOverwrites: [{ roleId: ROLE_A, ...overwrite(PermissionFlagsBits.ViewChannel) }],
        }),
      ]),
    });
    const evidence = await refresh(subject);
    expect(evidence.map(item => [item.channelId, item.psfnEvidenceResult, item.decisionReason]))
      .toEqual([
        [CHANNEL_A, false, 'view_channel_denied'],
        [CHANNEL_B, false, 'view_channel_denied'],
        [CHANNEL_C, true, undefined],
      ]);
  });

  it('requires explicit private-thread membership or current MANAGE_THREADS permission', async () => {
    const mappings = [
      mapping({ channelId: CHANNEL_A }),
      mapping({ channelId: CHANNEL_B }),
      mapping({ channelId: CHANNEL_C }),
    ];
    const subject = runtime({
      mappings,
      observe: () => observed([
        currentTarget({ channelId: CHANNEL_A, kind: 'private_thread', threadMember: true }),
        currentTarget({
          channelId: CHANNEL_B,
          kind: 'private_thread',
          rolePermissions: { [ROLE_A]: PermissionFlagsBits.ManageThreads },
        }),
        currentTarget({ channelId: CHANNEL_C, kind: 'private_thread', threadMember: false }),
      ]),
    });
    const evidence = await refresh(subject);
    expect(evidence.map(item => [item.threadId, item.channelId, item.psfnEvidenceResult]))
      .toEqual([
        [CHANNEL_A, PARENT_A, true],
        [CHANNEL_B, PARENT_A, true],
        [CHANNEL_C, PARENT_A, false],
      ]);
    expect(evidence[2]?.decisionReason).toBe('missing_private_thread_access');
  });

  it('accepts ADMINISTRATOR as native visibility and private-thread moderator evidence only', async () => {
    const subject = runtime({
      mappings: [mapping({ requiredRoleIds: [ROLE_B] })],
      observe: () => observed([currentTarget({
        kind: 'private_thread',
        threadMember: false,
        everyonePermissions: PermissionFlagsBits.Administrator,
      })]),
    });
    const [evidence] = await refresh(subject);
    expect(evidence).toMatchObject({
      discordPermissionResult: true,
      memberSpecificDenyVeto: false,
      psfnEvidenceResult: false,
      decisionReason: 'required_role_missing',
    });
  });

  it('replaces evidence on role and membership changes without treating guild membership as channel visibility', async () => {
    let currentRoles = [ROLE_A];
    const subject = runtime({
      mappings: [
        mapping({ channelId: undefined, requiredRoleIds: [ROLE_A] }),
        mapping({ channelId: CHANNEL_A }),
      ],
      providerMembership: () => providerMembership(currentRoles),
      observe: () => observed([
        {
          status: 'current',
          guildId: GUILD_ID,
          member: { roleIds: currentRoles, guildOwner: false },
          guildPermissions: {
            everyoneRoleId: GUILD_ID,
            everyonePermissions: '0',
            roles: currentRoles.map(roleId => ({ roleId, permissions: '0' })),
          },
        },
        currentTarget({ roleIds: currentRoles, everyonePermissions: 0n }),
      ]),
    });
    const first = await refresh(subject);
    currentRoles = [];
    const second = await refresh(subject);
    expect(first.map(item => item.psfnEvidenceResult)).toEqual([true, false]);
    expect(second.map(item => item.psfnEvidenceResult)).toEqual([false, false]);
    expect(second[0]?.decisionReason).toBe('required_role_missing');
    expect(second[0]?.inputDigest).not.toBe(first[0]?.inputDigest);
    expect(subject.store.replacements).toHaveLength(2);

    const removed = runtime({
      observe: () => observed([{
        status: 'membership_removed',
        guildId: GUILD_ID,
        requestedChannelId: CHANNEL_A,
      }]),
    });
    expect((await refresh(removed))[0]?.decisionReason).toBe('membership_removed');
  });

  it('fails closed for missing inputs, stale observations, provider outage, and bot absence', async () => {
    const incomplete = currentTarget();
    delete (incomplete.channel as Record<string, unknown>).overwritesComplete;
    const cases: Array<[unknown | (() => Promise<never>), string]> = [
      [observed([incomplete]), 'incomplete_observation'],
      [observed([currentTarget()], { observedAt: '2026-07-16T11:55:00.000Z' }), 'stale_observation'],
      [async () => { throw new Error('provider outage'); }, 'provider_unavailable'],
      [{ status: 'bot_absent' }, 'bot_absent'],
    ];
    for (const [result, reason] of cases) {
      const subject = runtime({
        observe: () => typeof result === 'function' ? result() : result,
      });
      const [evidence] = await refresh(subject);
      expect(evidence).toMatchObject({
        discordPermissionResult: false,
        psfnEvidenceResult: false,
        decisionReason: reason,
      });
    }

    const oauthOutage = runtime({
      providerMembership: () => ({ status: 'provider_unavailable' }),
      observe: () => observed([currentTarget()]),
    });
    expect((await refresh(oauthOutage))[0]?.decisionReason).toBe('provider_unavailable');
    expect(oauthOutage.observe).not.toHaveBeenCalled();

    const mismatchedRoles = runtime({
      providerMembership: () => providerMembership([ROLE_B]),
      observe: () => observed([currentTarget({ roleIds: [ROLE_A] })]),
    });
    expect((await refresh(mismatchedRoles))[0]?.decisionReason).toBe('incomplete_observation');
  });

  it('isolates bot observations and mappings per companion', async () => {
    const subject = runtime({
      mappings: [mapping(), mapping({ companionId: COMPANION_B })],
      observe: companionId => observed(
        [currentTarget()],
        { botUserId: companionId === COMPANION_A ? BOT_A : BOT_B },
      ),
    });
    const evidence = await refresh(subject);
    expect(subject.observe.mock.calls.map(([input]) => input.companionId).sort())
      .toEqual([COMPANION_A, COMPANION_B].sort());
    expect(evidence.map(item => [item.companionId, item.provenance.botUserId]))
      .toEqual([[COMPANION_A, BOT_A], [COMPANION_B, BOT_B]]);
  });

  it('refreshes and replaces only the companion named by a lifecycle event', async () => {
    const subject = runtime({
      mappings: [mapping(), mapping({ companionId: COMPANION_B, channelId: CHANNEL_B })],
      observe: companionId => observed(
        [currentTarget({ channelId: companionId === COMPANION_A ? CHANNEL_A : CHANNEL_B })],
        { botUserId: companionId === COMPANION_A ? BOT_A : BOT_B },
      ),
    });
    const evidence = await subject.runtime.refreshCompanionEvidence({
      principalId: PRINCIPAL_ID,
      providerSubjectId: SUBJECT_ID,
      providerMembershipEvidence: providerMembership(),
      companionId: COMPANION_A,
    });
    expect(subject.observe.mock.calls.map(([input]) => input.companionId)).toEqual([COMPANION_A]);
    expect(subject.store.companionReplacements).toEqual([COMPANION_A]);
    expect(evidence.map(item => item.companionId)).toEqual([COMPANION_A]);
  });

  it('uses cached positive evidence only for an unexpired exact input/config binding', async () => {
    const subject = runtime({ observe: () => observed([currentTarget()]) });
    const [snapshot] = await refresh(subject);
    const expected = {
      principalId: snapshot.principalId,
      providerSubjectId: snapshot.providerSubjectId,
      companionId: snapshot.companionId,
      guildId: snapshot.guildId,
      channelId: snapshot.channelId,
      threadId: snapshot.threadId,
      expectedInputDigest: snapshot.inputDigest,
      expectedConfigDigest: snapshot.configDigest,
      expectedMappingConfigVersion: snapshot.mappingConfigVersion,
      now: new Date('2026-07-16T12:04:59.999Z'),
    };
    expect(isUsablePositiveDiscordEvidence(snapshot, expected)).toBe(true);
    expect(isUsablePositiveDiscordEvidence(snapshot, {
      ...expected,
      expectedInputDigest: 'f'.repeat(64),
    })).toBe(false);
    expect(isUsablePositiveDiscordEvidence(snapshot, {
      ...expected,
      expectedConfigDigest: 'e'.repeat(64),
    })).toBe(false);
    expect(isUsablePositiveDiscordEvidence(snapshot, {
      ...expected,
      now: snapshot.expiresAt,
    })).toBe(false);
  });
});
