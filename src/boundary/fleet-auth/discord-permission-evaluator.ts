import { PermissionFlagsBits } from 'discord.js';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
} from '../../shared/utils/types.js';
import type {
  DiscordEvidenceFailureReason,
  DiscordEvidenceProvenance,
  DiscordEvidenceTarget,
} from './discord-evidence-types.js';

const SNOWFLAKE_PATTERN = /^[1-9][0-9]{16,19}$/u;
const DECIMAL_PERMISSION_PATTERN = /^(0|[1-9][0-9]*)$/u;

interface PermissionOverwrite {
  allow: bigint;
  deny: bigint;
}

interface RolePermission {
  roleId: string;
  permissions: bigint;
}

interface RoleOverwrite extends PermissionOverwrite {
  roleId: string;
}

interface NormalizedChannelObservation {
  kind: 'guild_channel' | 'public_thread' | 'private_thread';
  id: string;
  permissionChannelId: string;
  parentChannelId?: string;
  everyoneOverwrite: PermissionOverwrite | null;
  roleOverwrites: RoleOverwrite[];
  memberOverwrite: PermissionOverwrite | null;
  threadMember?: boolean;
}

export interface NormalizedCurrentDiscordTarget {
  status: 'current';
  guildId: string;
  requestedChannelId?: string;
  roleIds: string[];
  guildOwner: boolean;
  everyoneRoleId: string;
  everyonePermissions: bigint;
  rolePermissions: RolePermission[];
  channel?: NormalizedChannelObservation;
  permissionInputs: Record<string, unknown>;
}

export interface NormalizedRemovedDiscordTarget {
  status: 'membership_removed';
  guildId: string;
  requestedChannelId?: string;
  permissionInputs: Record<string, unknown>;
}

export type NormalizedDiscordTarget =
  | NormalizedCurrentDiscordTarget
  | NormalizedRemovedDiscordTarget;

export interface ParsedDiscordObservation {
  status: 'observed';
  providerSubjectId: string;
  observedAt: Date;
  provenance: DiscordEvidenceProvenance;
  targets: NormalizedDiscordTarget[];
}

export interface ParsedDiscordObservationFailure {
  status: 'provider_unavailable' | 'bot_absent';
  provenance: DiscordEvidenceProvenance;
}

export type ParsedDiscordObservationResult =
  | ParsedDiscordObservation
  | ParsedDiscordObservationFailure;

export interface DiscordPermissionDecision {
  discordPermissionResult: boolean;
  memberSpecificDenyVeto: boolean;
  psfnEvidenceResult: boolean;
  decisionReason?: DiscordEvidenceFailureReason;
  channelId?: string;
  threadId?: string;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requireSnowflake(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SNOWFLAKE_PATTERN.test(value)) {
    throw new Error(`${field} must be a Discord snowflake`);
  }
  return value;
}

function requirePermission(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || value.length > 24 || !DECIMAL_PERMISSION_PATTERN.test(value)) {
    throw new Error(`${field} must be a non-negative decimal permission string`);
  }
  return BigInt(value);
}

function requireUniqueSnowflakes(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 250) {
    throw new Error(`${field} must be an array of at most 250 roles`);
  }
  const ids = value.map((entry, index) => requireSnowflake(entry, `${field}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${field} must not contain duplicates`);
  return ids;
}

function parseOverwrite(value: unknown, field: string): PermissionOverwrite | null {
  if (value === null) return null;
  const record = requireRecord(value, field);
  assertNoUnknownKeys(record, ['allow', 'deny'], field);
  if (!Object.hasOwn(record, 'allow') || !Object.hasOwn(record, 'deny')) {
    throw new Error(`${field} must contain allow and deny`);
  }
  return {
    allow: requirePermission(record.allow, `${field}.allow`),
    deny: requirePermission(record.deny, `${field}.deny`),
  };
}

function parseRolePermissions(value: unknown, roleIds: readonly string[]): RolePermission[] {
  if (!Array.isArray(value) || value.length > 250) {
    throw new Error('target.guildPermissions.roles must be an array of at most 250 roles');
  }
  const roles = value.map((entry, index) => {
    const field = `target.guildPermissions.roles[${index}]`;
    const record = requireRecord(entry, field);
    assertNoUnknownKeys(record, ['roleId', 'permissions'], field);
    return {
      roleId: requireSnowflake(record.roleId, `${field}.roleId`),
      permissions: requirePermission(record.permissions, `${field}.permissions`),
    };
  });
  const observedRoleIds = roles.map(role => role.roleId);
  if (new Set(observedRoleIds).size !== observedRoleIds.length
    || observedRoleIds.length !== roleIds.length
    || observedRoleIds.some(roleId => !roleIds.includes(roleId))) {
    throw new Error('target.guildPermissions.roles must exactly cover the current member roles');
  }
  return roles;
}

function parseRoleOverwrites(value: unknown): RoleOverwrite[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error('target.channel.roleOverwrites must be an array of at most 1000 overwrites');
  }
  const roles = value.map((entry, index) => {
    const field = `target.channel.roleOverwrites[${index}]`;
    const record = requireRecord(entry, field);
    assertNoUnknownKeys(record, ['roleId', 'allow', 'deny'], field);
    return {
      roleId: requireSnowflake(record.roleId, `${field}.roleId`),
      allow: requirePermission(record.allow, `${field}.allow`),
      deny: requirePermission(record.deny, `${field}.deny`),
    };
  });
  if (new Set(roles.map(role => role.roleId)).size !== roles.length) {
    throw new Error('target.channel.roleOverwrites must not contain duplicates');
  }
  return roles;
}

function parseChannel(value: unknown, requestedChannelId: string): NormalizedChannelObservation {
  const record = requireRecord(value, 'target.channel');
  assertNoUnknownKeys(record, [
    'kind',
    'id',
    'permissionChannelId',
    'parentChannelId',
    'overwritesComplete',
    'everyoneOverwrite',
    'roleOverwrites',
    'memberOverwrite',
    'threadMembershipObserved',
    'threadMember',
  ], 'target.channel');
  if (record.kind !== 'guild_channel'
    && record.kind !== 'public_thread'
    && record.kind !== 'private_thread') {
    throw new Error('target.channel.kind is unknown');
  }
  if (record.overwritesComplete !== true) {
    throw new Error('target.channel.overwritesComplete must be true');
  }
  const id = requireSnowflake(record.id, 'target.channel.id');
  if (id !== requestedChannelId) throw new Error('target.channel.id does not match the requested surface');
  const permissionChannelId = requireSnowflake(
    record.permissionChannelId,
    'target.channel.permissionChannelId',
  );
  const common = {
    kind: record.kind,
    id,
    permissionChannelId,
    everyoneOverwrite: parseOverwrite(record.everyoneOverwrite, 'target.channel.everyoneOverwrite'),
    roleOverwrites: parseRoleOverwrites(record.roleOverwrites),
    memberOverwrite: parseOverwrite(record.memberOverwrite, 'target.channel.memberOverwrite'),
  };
  if (record.kind === 'guild_channel') {
    if (permissionChannelId !== id || record.parentChannelId !== undefined
      || record.threadMembershipObserved !== undefined || record.threadMember !== undefined) {
      throw new Error('guild channel permission inputs contain thread-only fields');
    }
    return common;
  }
  const parentChannelId = requireSnowflake(record.parentChannelId, 'target.channel.parentChannelId');
  if (permissionChannelId !== parentChannelId || parentChannelId === id) {
    throw new Error('thread permissions must be observed on its distinct parent channel');
  }
  if (record.kind === 'public_thread') {
    if (record.threadMembershipObserved !== undefined || record.threadMember !== undefined) {
      throw new Error('public thread input must not claim private membership evidence');
    }
    return { ...common, parentChannelId };
  }
  if (record.threadMembershipObserved !== true || typeof record.threadMember !== 'boolean') {
    throw new Error('private thread membership must be completely observed');
  }
  return { ...common, parentChannelId, threadMember: record.threadMember };
}

function parseTarget(value: unknown): NormalizedDiscordTarget {
  const record = requireRecord(value, 'target');
  assertNoUnknownKeys(record, [
    'status',
    'guildId',
    'requestedChannelId',
    'member',
    'guildPermissions',
    'channel',
  ], 'target');
  const guildId = requireSnowflake(record.guildId, 'target.guildId');
  const requestedChannelId = record.requestedChannelId === undefined
    ? undefined
    : requireSnowflake(record.requestedChannelId, 'target.requestedChannelId');
  if (record.status === 'membership_removed') {
    if (record.member !== undefined || record.guildPermissions !== undefined || record.channel !== undefined) {
      throw new Error('removed membership input must not contain permission claims');
    }
    return {
      status: 'membership_removed',
      guildId,
      ...(requestedChannelId ? { requestedChannelId } : {}),
      permissionInputs: structuredClone(record),
    };
  }
  if (record.status !== 'current') throw new Error('target.status is unknown');
  const member = requireRecord(record.member, 'target.member');
  assertNoUnknownKeys(member, ['roleIds', 'guildOwner'], 'target.member');
  const roleIds = requireUniqueSnowflakes(member.roleIds, 'target.member.roleIds');
  if (typeof member.guildOwner !== 'boolean') {
    throw new Error('target.member.guildOwner must be a boolean');
  }
  const guildPermissions = requireRecord(record.guildPermissions, 'target.guildPermissions');
  assertNoUnknownKeys(
    guildPermissions,
    ['everyoneRoleId', 'everyonePermissions', 'roles'],
    'target.guildPermissions',
  );
  const everyoneRoleId = requireSnowflake(
    guildPermissions.everyoneRoleId,
    'target.guildPermissions.everyoneRoleId',
  );
  if (roleIds.includes(everyoneRoleId)) {
    throw new Error('target.member.roleIds must not repeat the everyone role');
  }
  const channel = requestedChannelId === undefined
    ? undefined
    : parseChannel(record.channel, requestedChannelId);
  if (requestedChannelId === undefined && record.channel !== undefined) {
    throw new Error('guild-only target must not contain channel permission inputs');
  }
  return {
    status: 'current',
    guildId,
    ...(requestedChannelId ? { requestedChannelId } : {}),
    roleIds,
    guildOwner: member.guildOwner,
    everyoneRoleId,
    everyonePermissions: requirePermission(
      guildPermissions.everyonePermissions,
      'target.guildPermissions.everyonePermissions',
    ),
    rolePermissions: parseRolePermissions(guildPermissions.roles, roleIds),
    ...(channel ? { channel } : {}),
    permissionInputs: structuredClone(record),
  };
}

export function parseDiscordEvidenceObservation(
  value: unknown,
  expectedProviderSubjectId: string,
  maximumTargets: number,
): ParsedDiscordObservationResult {
  const record = requireRecord(value, 'observation');
  if (record.status === 'provider_unavailable' || record.status === 'bot_absent') {
    assertNoUnknownKeys(record, ['status', 'observationId'], 'observation');
    const observationId = record.observationId;
    if (observationId !== undefined
      && (typeof observationId !== 'string'
        || observationId.length === 0
        || observationId.length > 256)) {
      throw new Error('observation.observationId is invalid');
    }
    return {
      status: record.status,
      provenance: {
        source: 'discord_oauth_and_bot_observation',
        provider: 'discord',
        providerSubjectId: expectedProviderSubjectId,
        observationStatus: record.status,
        ...(typeof observationId === 'string' ? { observationId } : {}),
      },
    };
  }
  assertNoUnknownKeys(
    record,
    ['status', 'providerSubjectId', 'observedAt', 'observationId', 'botUserId', 'targets'],
    'observation',
  );
  if (record.status !== 'observed') throw new Error('observation.status is unknown');
  const providerSubjectId = requireSnowflake(record.providerSubjectId, 'observation.providerSubjectId');
  if (providerSubjectId !== expectedProviderSubjectId) {
    throw new Error('observation provider subject does not match the requested principal');
  }
  if (!isCanonicalIsoTimestamp(record.observedAt)) {
    throw new Error('observation.observedAt must be a canonical timestamp');
  }
  if (typeof record.observationId !== 'string'
    || record.observationId.length === 0 || record.observationId.length > 256) {
    throw new Error('observation.observationId is invalid');
  }
  const botUserId = requireSnowflake(record.botUserId, 'observation.botUserId');
  if (!Array.isArray(record.targets) || record.targets.length > maximumTargets) {
    throw new Error('observation.targets exceeds the requested bounded target set');
  }
  const targets = record.targets.map(parseTarget);
  const identities = targets.map(target => (
    `${target.guildId}\u0000${target.requestedChannelId ?? ''}`
  ));
  if (new Set(identities).size !== identities.length) {
    throw new Error('observation.targets must not contain duplicate targets');
  }
  return {
    status: 'observed',
    providerSubjectId,
    observedAt: new Date(record.observedAt),
    provenance: {
      source: 'discord_oauth_and_bot_observation',
      provider: 'discord',
      providerSubjectId,
      observationStatus: 'observed',
      observedAt: record.observedAt,
      observationId: record.observationId,
      botUserId,
    },
    targets,
  };
}

function applyOverwrite(permissions: bigint, overwrite: PermissionOverwrite | null): bigint {
  if (!overwrite) return permissions;
  return (permissions & ~overwrite.deny) | overwrite.allow;
}

function hasPermission(permissions: bigint, permission: bigint): boolean {
  return (permissions & permission) === permission;
}

export function evaluateDiscordPermission(
  target: NormalizedDiscordTarget,
  requiredRoleIds: readonly string[],
): DiscordPermissionDecision {
  if (target.status === 'membership_removed') {
    return {
      discordPermissionResult: false,
      memberSpecificDenyVeto: false,
      psfnEvidenceResult: false,
      decisionReason: 'membership_removed',
    };
  }
  if (!target.channel) {
    const rolesSatisfied = requiredRoleIds.every(roleId => target.roleIds.includes(roleId));
    return {
      discordPermissionResult: true,
      memberSpecificDenyVeto: false,
      psfnEvidenceResult: rolesSatisfied,
      ...(rolesSatisfied ? {} : { decisionReason: 'required_role_missing' as const }),
    };
  }

  let permissions = target.rolePermissions.reduce(
    (result, role) => result | role.permissions,
    target.everyonePermissions,
  );
  const administrator = target.guildOwner
    || hasPermission(permissions, PermissionFlagsBits.Administrator);
  const memberSpecificDenyVeto = Boolean(
    target.channel.memberOverwrite
    && hasPermission(target.channel.memberOverwrite.deny, PermissionFlagsBits.ViewChannel),
  );
  if (!administrator) {
    permissions = applyOverwrite(permissions, target.channel.everyoneOverwrite);
    let aggregateRoleDeny = 0n;
    let aggregateRoleAllow = 0n;
    for (const overwrite of target.channel.roleOverwrites) {
      if (!target.roleIds.includes(overwrite.roleId)) continue;
      aggregateRoleDeny |= overwrite.deny;
      aggregateRoleAllow |= overwrite.allow;
    }
    permissions = (permissions & ~aggregateRoleDeny) | aggregateRoleAllow;
    permissions = applyOverwrite(permissions, target.channel.memberOverwrite);
  }
  const viewChannel = administrator
    || hasPermission(permissions, PermissionFlagsBits.ViewChannel);
  const privateThreadAccess = target.channel.kind !== 'private_thread'
    || target.channel.threadMember === true
    || administrator
    || hasPermission(permissions, PermissionFlagsBits.ManageThreads);
  const discordPermissionResult = viewChannel && privateThreadAccess;
  const rolesSatisfied = requiredRoleIds.every(roleId => target.roleIds.includes(roleId));
  const psfnEvidenceResult = discordPermissionResult
    && !memberSpecificDenyVeto
    && rolesSatisfied;

  let decisionReason: DiscordEvidenceFailureReason | undefined;
  if (memberSpecificDenyVeto) decisionReason = 'member_specific_deny';
  else if (!viewChannel) decisionReason = 'view_channel_denied';
  else if (!privateThreadAccess) decisionReason = 'missing_private_thread_access';
  else if (!rolesSatisfied) decisionReason = 'required_role_missing';

  return {
    discordPermissionResult,
    memberSpecificDenyVeto,
    psfnEvidenceResult,
    ...(decisionReason ? { decisionReason } : {}),
    ...(target.channel.kind === 'guild_channel'
      ? { channelId: target.channel.id }
      : { channelId: target.channel.parentChannelId, threadId: target.channel.id }),
  };
}

export function findObservedTarget(
  targets: readonly NormalizedDiscordTarget[],
  expected: DiscordEvidenceTarget,
): NormalizedDiscordTarget | undefined {
  return targets.find(target => target.guildId === expected.guildId
    && target.requestedChannelId === expected.channelId);
}
