import type { GatewayClient } from '../../boundary/gateway/client.js';
import type {
  IcpInitiationHandoffPrepareResult,
  IcpOwnAvailabilityResult,
  IcpPeerAvailabilityResult,
} from '../../boundary/gateway/icp-autonomy-contract.js';
import type { ContactStorePort } from '../contacts/contact-store-port.js';
import type { Contact } from '../contacts/types.js';
import type {
  IcpAvailabilityLease,
  IcpAvailabilityState,
  IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import type { IcpContinuationTaskKind } from '../../shared/contracts/runtime.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';

export interface KnownCompanionPeer {
  contactId: string;
  displayName: string;
  peerCompanionId: string;
}

export interface KnownCompanionPeerAvailability extends KnownCompanionPeer {
  availability: IcpPeerAvailabilityResult;
}

/** Expected canonical-peer validation failure; infrastructure failures must propagate. */
export class CanonicalCompanionPeerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalCompanionPeerValidationError';
  }
}

export interface IcpAgentGatewayPort {
  companionReadOwnAvailability(): Promise<IcpOwnAvailabilityResult>;
  companionPublishAvailability(input: {
    state: IcpAvailabilityState;
    expiresAtMs: number;
    revision: number;
  }): Promise<IcpAvailabilityLease>;
  companionClearAvailability(input: {
    expectedRevision: number;
  }): Promise<{ cleared: boolean }>;
  companionReadPeerAvailability(input: {
    peerCompanionId: string;
  }): Promise<IcpPeerAvailabilityResult>;
  companionPrepareInitiationHandoff(input: {
    permitId: string;
    peerContactId: string;
  }): Promise<IcpInitiationHandoffPrepareResult>;
}

export interface IcpTargetChannelCommandPort {
  execute(input: {
    permit: IcpInitiationPermit;
    rootInitiationId: string;
    peerContactId: string;
    continuationTaskKind?: IcpContinuationTaskKind;
  }): Promise<unknown>;
}

export interface AgentFacingIcpAutonomyRuntime {
  resolveKnownPeer(contactId: string): Promise<KnownCompanionPeer>;
  readKnownPeerAvailability(contact: Contact): Promise<KnownCompanionPeerAvailability | null>;
  listKnownPeerAvailability(): Promise<KnownCompanionPeerAvailability[]>;
  readOwnAvailability(): Promise<IcpOwnAvailabilityResult>;
  publishOwnAvailability(input: {
    state: IcpAvailabilityState;
    expiresAtMs: number;
    revision: number;
  }): Promise<IcpAvailabilityLease>;
  clearOwnAvailability(expectedRevision: number): Promise<{ cleared: boolean }>;
  prepareCompanionOutreach(contactId: string, permitId: string): Promise<void>;
  executeCompanionOutreach(
    contactId: string,
    permitId: string,
    continuationTaskKind?: IcpContinuationTaskKind,
    isExecutionAuthorized?: () => boolean,
  ): Promise<void>;
}

function displayName(contact: Contact): string {
  return contact.nickname?.trim() || contact.displayName.trim() || contact.id;
}

function collectCompanionIds(contact: Contact): string[] {
  const ids = new Set<string>();
  for (const identity of contact.channelIdentities ?? []) {
    if (identity.channel.trim().toLowerCase() === 'companion') {
      ids.add(identity.userId.trim());
    }
  }
  for (const channel of contact.channels ?? []) {
    if (channel.channel.trim().toLowerCase() === 'companion') {
      ids.add(channel.userId.trim());
    }
  }
  return [...ids];
}

async function resolveCanonicalKnownPeer(
  contactStore: ContactStorePort,
  contact: Contact,
): Promise<KnownCompanionPeer> {
  if (!contact.isMachineIntelligence) {
    throw new CanonicalCompanionPeerValidationError(
      'contact is not a canonical machine-intelligence peer',
    );
  }
  const companionIds = collectCompanionIds(contact);
  if (companionIds.length !== 1 || !isRfc4122Uuid(companionIds[0])) {
    throw new CanonicalCompanionPeerValidationError(
      'contact does not have exactly one canonical companion identity',
    );
  }
  const peerCompanionId = companionIds[0];
  const reverse = await contactStore.getByChannelIdentity('companion', peerCompanionId);
  if (!reverse || reverse.id !== contact.id || !reverse.isMachineIntelligence) {
    throw new CanonicalCompanionPeerValidationError(
      'contact companion identity does not reverse-resolve canonically',
    );
  }
  return {
    contactId: contact.id,
    displayName: displayName(contact),
    peerCompanionId,
  };
}

function requireExactContactId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized !== value) {
    throw new Error('contact_id must be an exact non-empty canonical contact ID');
  }
  return normalized;
}

function requirePermitId(value: string): string {
  if (!isRfc4122Uuid(value)) {
    throw new Error('initiation_permit must be a lowercase RFC-4122 UUID');
  }
  return value;
}

export function createAgentFacingIcpAutonomyRuntime(input: {
  contactStore: ContactStorePort;
  gateway: IcpAgentGatewayPort | GatewayClient;
  command: IcpTargetChannelCommandPort;
}): AgentFacingIcpAutonomyRuntime {
  const resolveKnownPeer = async (contactId: string): Promise<KnownCompanionPeer> => {
    const canonicalContactId = requireExactContactId(contactId);
    const contact = await input.contactStore.getById(canonicalContactId);
    if (!contact) throw new Error('canonical contact ID was not found');
    return await resolveCanonicalKnownPeer(input.contactStore, contact);
  };

  const readKnownPeerAvailability = async (
    contact: Contact,
  ): Promise<KnownCompanionPeerAvailability | null> => {
    if (!contact.isMachineIntelligence) return null;
    let peer: KnownCompanionPeer;
    try {
      peer = await resolveCanonicalKnownPeer(input.contactStore, contact);
    } catch (error) {
      if (!(error instanceof CanonicalCompanionPeerValidationError)) throw error;
      return null;
    }
    const availability = await input.gateway.companionReadPeerAvailability({
      peerCompanionId: peer.peerCompanionId,
    });
    if (availability.peerCompanionId !== peer.peerCompanionId) {
      throw new Error('gateway returned availability for a different peer');
    }
    return { ...peer, availability };
  };

  const prepare = async (
    contactId: string,
    permitId: string,
  ): Promise<{ peer: KnownCompanionPeer; handoff: Extract<IcpInitiationHandoffPrepareResult, { authorized: true }> }> => {
    const peer = await resolveKnownPeer(contactId);
    const handoff = await input.gateway.companionPrepareInitiationHandoff({
      permitId: requirePermitId(permitId),
      peerContactId: peer.contactId,
    });
    if (!handoff.authorized) {
      throw new Error(`companion outreach denied: ${handoff.reasonCode}`);
    }
    if (handoff.permit.recipientCompanionId !== peer.peerCompanionId) {
      throw new Error('companion outreach permit recipient does not match the canonical contact');
    }
    return { peer, handoff };
  };

  return {
    resolveKnownPeer,
    readKnownPeerAvailability,
    async listKnownPeerAvailability() {
      const contacts = await input.contactStore.listAll();
      const peers: KnownCompanionPeerAvailability[] = [];
      for (const contact of contacts) {
        const result = await readKnownPeerAvailability(contact);
        if (result) peers.push(result);
      }
      return peers;
    },
    readOwnAvailability: async () => await input.gateway.companionReadOwnAvailability(),
    publishOwnAvailability: async publishInput => await input.gateway.companionPublishAvailability(publishInput),
    clearOwnAvailability: async expectedRevision => await input.gateway.companionClearAvailability({ expectedRevision }),
    async prepareCompanionOutreach(contactId, permitId) {
      await prepare(contactId, permitId);
    },
    async executeCompanionOutreach(
      contactId,
      permitId,
      continuationTaskKind,
      isExecutionAuthorized,
    ) {
      const { peer, handoff } = await prepare(contactId, permitId);
      if (isExecutionAuthorized && !isExecutionAuthorized()) {
        throw new Error('companion outreach authorization changed during broker preparation');
      }
      await input.command.execute({
        permit: handoff.permit,
        rootInitiationId: handoff.rootInitiationId,
        peerContactId: peer.contactId,
        ...(continuationTaskKind ? { continuationTaskKind } : {}),
      });
    },
  };
}
