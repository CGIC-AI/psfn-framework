import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { RelationshipType } from '../../core/contacts/types.js';
import type {
  FleetAuthAccountRosterEntry,
  FleetAuthRole,
} from '../../system/config/fleet-auth-config.js';

const PROVISIONING_ACTOR = 'operator:provision:fleet-contacts';

interface FleetContactCompanion {
  readonly companionId: string;
}

interface FleetContactPlanEntry {
  readonly ownerCompanionId: string;
  readonly channel: 'companion' | 'discord';
  readonly channelUserId: string;
  readonly displayName: string;
  readonly relationshipType: RelationshipType;
  readonly contactId?: string;
}

export interface FleetContactTopologyOptions {
  readonly companions: readonly FleetContactCompanion[];
  readonly accountRoster: readonly FleetAuthAccountRosterEntry[];
  readonly stores: ReadonlyMap<string, ContactStorePort>;
}

export interface FleetContactTopologyVerification {
  readonly companionCount: number;
  readonly siblingContactCount: number;
  readonly humanContactCount: number;
}

function roleRank(role: FleetAuthRole): number {
  switch (role) {
    case 'owner': return 2;
    case 'admin': return 1;
    case 'member':
    case 'guest':
      return 0;
  }
}

function initialHumanRelationship(role: FleetAuthRole): RelationshipType {
  return role === 'owner' ? 'friend' : 'acquaintance';
}

function buildFleetContactPlan(
  companions: readonly FleetContactCompanion[],
  accountRoster: readonly FleetAuthAccountRosterEntry[],
): FleetContactPlanEntry[] {
  if (companions.length === 0) {
    throw new Error('Fleet contact provisioning requires at least one companion');
  }
  const companionIds = new Set(companions.map(companion => companion.companionId));
  if (companionIds.size !== companions.length) {
    throw new Error('Fleet contact provisioning requires unique companion identities');
  }
  const unknownRosterEntry = accountRoster.find(entry => !companionIds.has(entry.companionId));
  if (unknownRosterEntry) {
    throw new Error(
      `Fleet contact provisioning roster references unknown companion ${unknownRosterEntry.companionId}`,
    );
  }
  const administrators = accountRoster.filter(entry => (
    (entry.role === 'owner' || entry.role === 'admin')
  ));
  if (administrators.length === 0) {
    throw new Error('Fleet contact provisioning requires a rostered owner or admin');
  }
  const administratorSubjects = [...new Set(
    administrators.map(entry => entry.providerSubjectId),
  )].sort();

  const plan: FleetContactPlanEntry[] = [];
  for (const owner of companions) {
    for (const peer of companions) {
      if (peer.companionId === owner.companionId) continue;
      plan.push({
        ownerCompanionId: owner.companionId,
        channel: 'companion',
        channelUserId: peer.companionId,
        displayName: `Companion ${peer.companionId.slice(0, 8)}`,
        relationshipType: 'ai_companion',
      });
    }
    for (const providerSubjectId of administratorSubjects) {
      const subjectEntries = administrators
        .filter(entry => entry.providerSubjectId === providerSubjectId);
      const highestRoleEntry = subjectEntries
        .sort((left, right) => roleRank(right.role) - roleRank(left.role))
        .at(0);
      if (!highestRoleEntry) {
        throw new Error('Fleet contact provisioning lost a rostered administrator');
      }
      const rosterEntry = subjectEntries.find(
        entry => entry.companionId === owner.companionId,
      ) ?? highestRoleEntry;
      plan.push({
        ownerCompanionId: owner.companionId,
        channel: 'discord',
        channelUserId: providerSubjectId,
        displayName: `Fleet ${rosterEntry.role} ${providerSubjectId}`,
        relationshipType: initialHumanRelationship(rosterEntry.role),
        ...(rosterEntry.companionId === owner.companionId && rosterEntry.contactId
          ? { contactId: rosterEntry.contactId }
          : {}),
      });
    }
  }
  return plan;
}

function requireStore(
  stores: ReadonlyMap<string, ContactStorePort>,
  companionId: string,
): ContactStorePort {
  const store = stores.get(companionId);
  if (!store) {
    throw new Error(`Fleet contact provisioning has no store for companion ${companionId}`);
  }
  return store;
}

export async function provisionFleetContactTopology(
  options: FleetContactTopologyOptions,
): Promise<FleetContactTopologyVerification> {
  const plan = buildFleetContactPlan(options.companions, options.accountRoster);
  for (const entry of plan) {
    const store = requireStore(options.stores, entry.ownerCompanionId);
    let contact = await store.getByChannelIdentity(entry.channel, entry.channelUserId);
    if (entry.contactId && contact && contact.id !== entry.contactId) {
      throw new Error(
        `Fleet contact provisioning found ${entry.channel}:${entry.channelUserId} `
        + `at ${contact.id}, expected configured contact ${entry.contactId}`,
      );
    }
    if (!contact && entry.contactId) {
      const configuredContact = await store.getById(entry.contactId);
      if (configuredContact) {
        const link = await store.linkChannelIdentity(
          configuredContact.id,
          entry.channel,
          entry.channelUserId,
          undefined,
          PROVISIONING_ACTOR,
        );
        if (link !== 'linked' && link !== 'already_linked') {
          throw new Error(
            `Fleet contact provisioning could not link configured contact ${entry.contactId}: ${link}`,
          );
        }
        contact = await store.getByChannelIdentity(entry.channel, entry.channelUserId);
        if (!contact || contact.id !== entry.contactId) {
          throw new Error(
            `Fleet contact provisioning could not resolve linked contact ${entry.contactId}`,
          );
        }
      }
    }
    if (!contact) {
      if (entry.channel === 'companion') {
        contact = await store.resolveChannelIdentity(
          entry.channel,
          entry.channelUserId,
          entry.displayName,
        );
      } else {
        contact = await store.upsert({
          ...(entry.contactId ? { id: entry.contactId } : {}),
          displayName: entry.displayName,
          discordUserId: entry.channelUserId,
          trustLevel: 'public',
          relationshipType: entry.relationshipType,
          channels: [{
            channel: entry.channel,
            userId: entry.channelUserId,
            privacyLevel: 'private',
          }],
        }, { actor: PROVISIONING_ACTOR });
      }
    }
    if (contact.relationshipType !== entry.relationshipType) {
      const updated = await store.updateRelationshipType(
        contact.id,
        entry.relationshipType,
        PROVISIONING_ACTOR,
      );
      if (!updated) {
        throw new Error(`Fleet contact provisioning could not set relationship for ${contact.id}`);
      }
    }
  }
  return await verifyFleetContactTopology(options);
}

export async function verifyFleetContactTopology(
  options: FleetContactTopologyOptions,
): Promise<FleetContactTopologyVerification> {
  const plan = buildFleetContactPlan(options.companions, options.accountRoster);
  let siblingContactCount = 0;
  let humanContactCount = 0;
  for (const entry of plan) {
    const store = requireStore(options.stores, entry.ownerCompanionId);
    const contact = await store.getByChannelIdentity(entry.channel, entry.channelUserId);
    if (!contact) {
      throw new Error(
        `Fleet contact consistency missing ${entry.channel}:${entry.channelUserId} `
        + `for companion ${entry.ownerCompanionId}`,
      );
    }
    if (entry.contactId && contact.id !== entry.contactId) {
      throw new Error(
        `Fleet contact consistency expected configured contact ${entry.contactId}, found ${contact.id}`,
      );
    }
    if (contact.relationshipType !== entry.relationshipType) {
      throw new Error(
        `Fleet contact consistency expected relationship ${entry.relationshipType} `
        + `for ${entry.channel}:${entry.channelUserId}, found ${contact.relationshipType}`,
      );
    }
    if (entry.channel === 'companion') siblingContactCount += 1;
    else humanContactCount += 1;
  }
  return {
    companionCount: options.companions.length,
    siblingContactCount,
    humanContactCount,
  };
}
