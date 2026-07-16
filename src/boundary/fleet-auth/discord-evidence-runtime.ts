import { randomUUID } from 'node:crypto';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';
import {
  digestDiscordEvidence,
  type DiscordEvidenceFailureReason,
  type DiscordEvidenceLifecycleMutation,
  type DiscordEvidenceObservationPort,
  type DiscordEvidenceProvenance,
  type DiscordEvidenceSnapshot,
  type DiscordEvidenceStorePort,
  type DiscordEvidenceTarget,
} from './discord-evidence-types.js';
import {
  evaluateDiscordPermission,
  findObservedTarget,
  parseDiscordEvidenceObservation,
  type ParsedDiscordObservationFailure,
} from './discord-permission-evaluator.js';

const DISCORD_SNOWFLAKE_PATTERN = /^[1-9][0-9]{16,19}$/u;

export interface DiscordEvidenceRuntimeOptions {
  config: FleetAuthConfig;
  observer: DiscordEvidenceObservationPort;
  store: DiscordEvidenceStorePort;
  now?: () => Date;
}

export interface ProviderGuildMembership {
  guildId: string;
  roleIds: string[];
}

export interface ProviderMembershipObservation {
  status: 'observed';
  observedAt: Date;
  guilds: ProviderGuildMembership[];
}

export function parseProviderMembershipEvidence(
  value: unknown,
  expectedProviderSubjectId: string,
  maximumGuilds: number,
): ProviderMembershipObservation | { status: 'provider_unavailable' } {
  if (!isRecord(value)) throw new Error('OAuth guild membership evidence must be an object');
  if (value.status === 'provider_unavailable') {
    assertNoUnknownKeys(value, ['status'], 'providerMembershipEvidence');
    return { status: 'provider_unavailable' };
  }
  assertNoUnknownKeys(
    value,
    ['status', 'providerSubjectId', 'observedAt', 'guilds'],
    'providerMembershipEvidence',
  );
  if (value.status !== 'observed' || value.providerSubjectId !== expectedProviderSubjectId
    || !isCanonicalIsoTimestamp(value.observedAt) || !Array.isArray(value.guilds)
    || value.guilds.length > maximumGuilds) {
    throw new Error('OAuth guild membership evidence is incomplete');
  }
  const guilds = value.guilds.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`OAuth guild membership ${index} must be an object`);
    assertNoUnknownKeys(entry, ['guildId', 'roleIds'], `providerMembershipEvidence.guilds[${index}]`);
    if (typeof entry.guildId !== 'string' || !DISCORD_SNOWFLAKE_PATTERN.test(entry.guildId)
      || !Array.isArray(entry.roleIds) || entry.roleIds.length > 250) {
      throw new Error(`OAuth guild membership ${index} is incomplete`);
    }
    const roleIds = entry.roleIds.map((roleId, roleIndex) => {
      if (typeof roleId !== 'string' || !DISCORD_SNOWFLAKE_PATTERN.test(roleId)) {
        throw new Error(`OAuth guild membership ${index} role ${roleIndex} is invalid`);
      }
      return roleId;
    }).sort();
    if (new Set(roleIds).size !== roleIds.length) {
      throw new Error(`OAuth guild membership ${index} repeats a role`);
    }
    return { guildId: entry.guildId, roleIds };
  });
  if (new Set(guilds.map(guild => guild.guildId)).size !== guilds.length) {
    throw new Error('OAuth guild membership evidence repeats a guild');
  }
  return { status: 'observed', observedAt: new Date(value.observedAt), guilds };
}

function mappingIdentity(mapping: {
  guildId: string;
  channelId: string | null;
  companionId: string;
  requiredRoleIds: readonly string[];
}): string {
  return [
    mapping.guildId,
    mapping.channelId ?? '',
    mapping.companionId,
    [...mapping.requiredRoleIds].sort().join(','),
  ].join('\u0000');
}

function observationTargetIdentity(target: DiscordEvidenceTarget): string {
  return `${target.guildId}\u0000${target.channelId ?? ''}`;
}

function configDigest(config: FleetAuthConfig): string {
  return digestDiscordEvidence({
    schemaVersion: config.schemaVersion,
    activationGeneration: config.activationGeneration,
    discordEvidenceMs: config.ttls.discordEvidenceMs,
    mappings: config.discordEvidenceMappings
      .map(mapping => ({
        guildId: mapping.guildId,
        channelId: mapping.channelId ?? null,
        companionId: mapping.companionId,
        requiredRoleIds: [...mapping.requiredRoleIds].sort(),
      }))
      .sort((left, right) => mappingIdentity(left).localeCompare(mappingIdentity(right))),
  });
}

function failurePermissionInputs(
  reason: DiscordEvidenceFailureReason,
  provenance: DiscordEvidenceProvenance,
): Record<string, unknown> {
  return {
    observation: {
      status: provenance.observationStatus,
      reason,
      ...(provenance.observationId ? { observationId: provenance.observationId } : {}),
      ...(provenance.observedAt ? { observedAt: provenance.observedAt } : {}),
      ...(provenance.oauthObservedAt ? { oauthObservedAt: provenance.oauthObservedAt } : {}),
      ...(provenance.botUserId ? { botUserId: provenance.botUserId } : {}),
    },
  };
}

export class DiscordEvidenceRuntime {
  private readonly config: FleetAuthConfig;
  private readonly observer: DiscordEvidenceObservationPort;
  private readonly store: DiscordEvidenceStorePort;
  private readonly now: () => Date;
  private readonly currentConfigDigest: string;

  constructor(options: DiscordEvidenceRuntimeOptions) {
    this.config = options.config;
    this.observer = options.observer;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.currentConfigDigest = configDigest(options.config);
  }

  async refreshPrincipalEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    providerMembershipEvidence: unknown;
    mutation: DiscordEvidenceLifecycleMutation;
  }): Promise<DiscordEvidenceSnapshot[]> {
    return await this.refreshEvidence(input);
  }

  async refreshCompanionEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    providerMembershipEvidence: unknown;
    companionId: string;
    mutation: DiscordEvidenceLifecycleMutation;
  }): Promise<DiscordEvidenceSnapshot[]> {
    return await this.refreshEvidence(input);
  }

  private async refreshEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    providerMembershipEvidence: unknown;
    companionId?: string;
    mutation: DiscordEvidenceLifecycleMutation;
  }): Promise<DiscordEvidenceSnapshot[]> {
    if (!isRfc4122Uuid(input.principalId)) throw new Error('Invalid fleet principal ID');
    if (!DISCORD_SNOWFLAKE_PATTERN.test(input.providerSubjectId)) {
      throw new Error('Invalid Discord provider subject ID');
    }
    let providerMembership: ReturnType<typeof parseProviderMembershipEvidence>;
    const selectedMappings = this.config.discordEvidenceMappings.filter(mapping => (
      input.companionId === undefined || mapping.companionId === input.companionId
    ));
    if (input.companionId !== undefined && selectedMappings.length === 0) return [];
    const mappedGuildCount = new Set(
      this.config.discordEvidenceMappings.map(mapping => mapping.guildId),
    ).size;
    try {
      providerMembership = parseProviderMembershipEvidence(
        input.providerMembershipEvidence,
        input.providerSubjectId,
        mappedGuildCount,
      );
    } catch {
      const evaluatedAt = this.now();
      const provenance: DiscordEvidenceProvenance = {
        source: 'discord_oauth_and_bot_observation',
        provider: 'discord',
        providerSubjectId: input.providerSubjectId,
        observationStatus: 'invalid',
      };
      const snapshots = selectedMappings.map(mapping => this.denialSnapshot({
        ...input,
        mapping,
        evaluatedAt,
        provenance,
        reason: 'incomplete_observation',
      }));
      await this.replaceSelectedEvidence(input, snapshots);
      return snapshots;
    }
    if (providerMembership.status === 'provider_unavailable') {
      const evaluatedAt = this.now();
      const provenance: DiscordEvidenceProvenance = {
        source: 'discord_oauth_and_bot_observation',
        provider: 'discord',
        providerSubjectId: input.providerSubjectId,
        observationStatus: 'provider_unavailable',
      };
      const snapshots = selectedMappings.map(mapping => this.denialSnapshot({
        ...input,
        mapping,
        evaluatedAt,
        provenance,
        reason: 'provider_unavailable',
      }));
      await this.replaceSelectedEvidence(input, snapshots);
      return snapshots;
    }
    const mappingsByCompanion = new Map<string, FleetAuthConfig['discordEvidenceMappings']>();
    for (const mapping of selectedMappings) {
      const existing = mappingsByCompanion.get(mapping.companionId) ?? [];
      existing.push(mapping);
      mappingsByCompanion.set(mapping.companionId, existing);
    }
    const snapshots: DiscordEvidenceSnapshot[] = [];
    for (const [companionId, mappings] of mappingsByCompanion) {
      const targets = [...new Map(mappings.map(mapping => {
        const target = {
          guildId: mapping.guildId,
          ...(mapping.channelId ? { channelId: mapping.channelId } : {}),
        };
        return [observationTargetIdentity(target), target];
      })).values()].sort((left, right) => (
        observationTargetIdentity(left).localeCompare(observationTargetIdentity(right))
      ));
      let rawObservation: unknown;
      try {
        rawObservation = await this.observer.observe({
          providerSubjectId: input.providerSubjectId,
          companionId,
          targets,
        });
      } catch {
        rawObservation = { status: 'provider_unavailable' };
      }
      const evaluatedAt = this.now();
      try {
        const observation = parseDiscordEvidenceObservation(
          rawObservation,
          input.providerSubjectId,
          targets.length,
        );
        if (observation.status === 'observed'
          && (observation.targets.length !== targets.length
            || observation.targets.some(target => !targets.some(expected => (
              target.guildId === expected.guildId
              && target.requestedChannelId === expected.channelId
            ))))) {
          throw new Error('Discord bot observation did not exactly cover requested targets');
        }
        snapshots.push(...(observation.status === 'observed'
          ? this.evaluateObserved(input, mappings, providerMembership, observation, evaluatedAt)
          : this.evaluateUnavailable(input, mappings, observation, evaluatedAt)));
      } catch {
        const provenance: DiscordEvidenceProvenance = {
          source: 'discord_oauth_and_bot_observation',
          provider: 'discord',
          providerSubjectId: input.providerSubjectId,
          observationStatus: 'invalid',
        };
        snapshots.push(...mappings.map(mapping => this.denialSnapshot({
          ...input,
          mapping,
          evaluatedAt,
          provenance,
          reason: 'incomplete_observation',
        })));
      }
    }

    await this.replaceSelectedEvidence(input, snapshots);
    return snapshots;
  }

  private async replaceSelectedEvidence(
    input: {
      principalId: string;
      providerSubjectId: string;
      companionId?: string;
      mutation: DiscordEvidenceLifecycleMutation;
    },
    snapshots: readonly DiscordEvidenceSnapshot[],
  ): Promise<void> {
    if (input.companionId !== undefined) {
      await this.store.replaceCompanionEvidence({
        principalId: input.principalId,
        providerSubjectId: input.providerSubjectId,
        companionId: input.companionId,
        mutation: input.mutation,
        snapshots,
      });
      return;
    }
    await this.store.replacePrincipalEvidence({
      principalId: input.principalId,
      providerSubjectId: input.providerSubjectId,
      mutation: input.mutation,
      snapshots,
    });
  }

  private evaluateUnavailable(
    input: { principalId: string; providerSubjectId: string },
    mappings: FleetAuthConfig['discordEvidenceMappings'],
    observation: ParsedDiscordObservationFailure,
    evaluatedAt: Date,
  ): DiscordEvidenceSnapshot[] {
    const reason = observation.status === 'bot_absent' ? 'bot_absent' : 'provider_unavailable';
    return mappings.map(mapping => this.denialSnapshot({
      ...input,
      mapping,
      evaluatedAt,
      provenance: observation.provenance,
      reason,
    }));
  }

  private evaluateObserved(
    input: { principalId: string; providerSubjectId: string },
    mappings: FleetAuthConfig['discordEvidenceMappings'],
    providerMembership: ProviderMembershipObservation,
    observation: Extract<
      ReturnType<typeof parseDiscordEvidenceObservation>,
      { status: 'observed' }
    >,
    evaluatedAt: Date,
  ): DiscordEvidenceSnapshot[] {
    const stale = observation.observedAt.getTime() > evaluatedAt.getTime()
      || providerMembership.observedAt.getTime() > evaluatedAt.getTime()
      || observation.observedAt.getTime() + this.config.ttls.discordEvidenceMs <= evaluatedAt.getTime()
      || providerMembership.observedAt.getTime() + this.config.ttls.discordEvidenceMs <= evaluatedAt.getTime();
    return mappings.map((mapping) => {
      if (stale) {
        return this.denialSnapshot({
          ...input,
          mapping,
          evaluatedAt,
          provenance: {
            ...observation.provenance,
            oauthObservedAt: providerMembership.observedAt.toISOString(),
          },
          reason: 'stale_observation',
        });
      }
      const target = findObservedTarget(observation.targets, {
        guildId: mapping.guildId,
        ...(mapping.channelId ? { channelId: mapping.channelId } : {}),
      });
      if (!target) {
        return this.denialSnapshot({
          ...input,
          mapping,
          evaluatedAt,
          provenance: observation.provenance,
          reason: 'incomplete_observation',
        });
      }
      const providerGuild = providerMembership.guilds.find(guild => guild.guildId === mapping.guildId);
      if (!providerGuild) {
        return this.denialSnapshot({
          ...input,
          mapping,
          evaluatedAt,
          provenance: { ...observation.provenance, oauthObservedAt: providerMembership.observedAt.toISOString() },
          reason: 'membership_removed',
        });
      }
      if (target.status === 'membership_removed'
        || target.roleIds.length !== providerGuild.roleIds.length
        || target.roleIds.some(roleId => !providerGuild.roleIds.includes(roleId))) {
        return this.denialSnapshot({
          ...input,
          mapping,
          evaluatedAt,
          provenance: { ...observation.provenance, oauthObservedAt: providerMembership.observedAt.toISOString() },
          reason: target.status === 'membership_removed'
            ? 'membership_removed'
            : 'incomplete_observation',
        });
      }
      const decision = evaluateDiscordPermission(target, mapping.requiredRoleIds);
      const permissionInputs = {
        oauthGuildMembership: {
          observedAt: providerMembership.observedAt.toISOString(),
          guildId: providerGuild.guildId,
          roleIds: providerGuild.roleIds,
        },
        observation: {
          status: 'observed',
          observationId: observation.provenance.observationId,
          observedAt: observation.provenance.observedAt,
          botUserId: observation.provenance.botUserId,
        },
        target: target.permissionInputs,
      };
      return {
        evidenceId: randomUUID(),
        principalId: input.principalId,
        provider: 'discord',
        providerSubjectId: input.providerSubjectId,
        companionId: mapping.companionId,
        guildId: mapping.guildId,
        ...decision,
        permissionInputs,
        inputDigest: digestDiscordEvidence(permissionInputs),
        configDigest: this.currentConfigDigest,
        mappingConfigVersion: this.config.activationGeneration,
        provenance: {
          ...observation.provenance,
          oauthObservedAt: providerMembership.observedAt.toISOString(),
        },
        fetchedAt: evaluatedAt,
        expiresAt: new Date(
          Math.min(observation.observedAt.getTime(), providerMembership.observedAt.getTime())
          + this.config.ttls.discordEvidenceMs,
        ),
      };
    });
  }

  private denialSnapshot(input: {
    principalId: string;
    providerSubjectId: string;
    mapping: FleetAuthConfig['discordEvidenceMappings'][number];
    evaluatedAt: Date;
    provenance: DiscordEvidenceProvenance;
    reason: DiscordEvidenceFailureReason;
  }): DiscordEvidenceSnapshot {
    const permissionInputs = failurePermissionInputs(input.reason, input.provenance);
    return {
      evidenceId: randomUUID(),
      principalId: input.principalId,
      provider: 'discord',
      providerSubjectId: input.providerSubjectId,
      companionId: input.mapping.companionId,
      guildId: input.mapping.guildId,
      ...(input.mapping.channelId ? { channelId: input.mapping.channelId } : {}),
      permissionInputs,
      discordPermissionResult: false,
      memberSpecificDenyVeto: false,
      psfnEvidenceResult: false,
      decisionReason: input.reason,
      inputDigest: digestDiscordEvidence(permissionInputs),
      configDigest: this.currentConfigDigest,
      mappingConfigVersion: this.config.activationGeneration,
      provenance: input.provenance,
      fetchedAt: input.evaluatedAt,
      expiresAt: new Date(input.evaluatedAt.getTime() + this.config.ttls.discordEvidenceMs),
    };
  }
}
