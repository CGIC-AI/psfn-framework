import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { RelationshipType } from '../../core/contacts/types.js';
import type {
  FleetAuthAccountRosterEntry,
  FleetAuthRole,
} from '../../system/config/fleet-auth-config.js';

import {
  applySiblingContactName,
  placeholderSiblingContactName,
  resolveSiblingContactName,
  type SiblingContactName,
  type SiblingNameSource,
} from './sibling-contact-name.js';

const PROVISIONING_ACTOR = 'operator:provision:fleet-contacts';

type FleetContactCompanion = SiblingNameSource;

interface FleetContactPlanEntry {
  readonly ownerCompanionId: string;
  readonly channel: 'companion' | 'discord';
  readonly channelUserId: string;
  readonly displayName: string;
  readonly relationshipType: RelationshipType;
  readonly contactId?: string;
  /** A sibling's real name (7frk9); absent for human contacts. */
  readonly siblingName?: SiblingContactName;
}

export interface FleetContactTopologyOptions {
  readonly companions: readonly FleetContactCompanion[];
  /**
   * Human-account source. `discord`: SSO mode, whose Discord-keyed roster must
   * name an owner or admin. `none`: key mode (key-or-SSO ruling), with no SSO
   * humans; only companion-to-companion contacts are provisioned and the
   * roster must be empty.
   */
  readonly ssoProvider: 'discord' | 'none';
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
  ssoProvider: 'discord' | 'none',
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
  if (ssoProvider === 'none' && accountRoster.length > 0) {
    throw new Error('Fleet contact provisioning without an SSO provider cannot use a Discord roster');
  }
  const administrators = accountRoster.filter(entry => (
    (entry.role === 'owner' || entry.role === 'admin')
  ));
  if (ssoProvider === 'discord' && administrators.length === 0) {
    throw new Error('Fleet contact provisioning requires a rostered owner or admin');
  }
  const administratorSubjects = [...new Set(
    administrators.map(entry => entry.providerSubjectId),
  )].sort();

  const siblingNames = new Map(companions.map(companion => [
    companion.companionId,
    resolveSiblingContactName(companion),
  ] as const));
  const plan: FleetContactPlanEntry[] = [];
  for (const owner of companions) {
    for (const peer of companions) {
      if (peer.companionId === owner.companionId) continue;
      const siblingName = siblingNames.get(peer.companionId);
      if (!siblingName) throw new Error(`Fleet contact provisioning lost the name of ${peer.companionId}`);
      plan.push({
        ownerCompanionId: owner.companionId,
        channel: 'companion',
        channelUserId: peer.companionId,
        displayName: siblingName.displayName,
        relationshipType: 'ai_companion',
        siblingName,
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
  const plan = buildFleetContactPlan(options.companions, options.accountRoster, options.ssoProvider);
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
          placeholderSiblingContactName(entry.channelUserId),
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
    if (entry.siblingName) {
      await applySiblingContactName(store, contact, entry.channelUserId, entry.siblingName, PROVISIONING_ACTOR);
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
  const plan = buildFleetContactPlan(options.companions, options.accountRoster, options.ssoProvider);
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
