import type { GatewayClient } from '../../boundary/gateway/client.js';
import type {
  IcpInitiationHandoffPrepareResult,
  IcpDyadLifecycleProjection,
  IcpDyadLifecycleResult,
  IcpOpenDyadProjection,
  IcpOwnAvailabilityResult,
  IcpPeerAvailabilityResult,
} from '../../boundary/gateway/icp-autonomy-contract.js';
import type { ContactStorePort } from '../contacts/contact-store-port.js';
import type { Contact } from '../contacts/types.js';
import type {
  IcpAvailabilityLease,
  IcpAvailabilityState,
  IcpInitiationPermit,
  IcpInitiationSource,
  IcpDyadSideAction,
} from '../../shared/contracts/icp-autonomy.js';
import type {
  IcpAutonomyCandidateOrigin,
  IcpContinuationTaskKind,
} from '../../shared/contracts/runtime.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import { parseIcpAutonomyCandidateOrigin } from './candidate-scheduler-origin.js';

export interface KnownCompanionPeer {
  contactId: string;
  displayName: string;
  peerCompanionId: string;
}

export interface KnownCompanionPeerAvailability extends KnownCompanionPeer {
  availability: IcpPeerAvailabilityResult;
}

export type CanonicalCompanionPeerValidationReason =
  | 'not_machine_intelligence'
  | 'invalid_companion_identity'
  | 'reverse_identity_mismatch';

/** Expected canonical-peer validation failure; infrastructure failures must propagate. */
export class CanonicalCompanionPeerValidationError extends Error {
  constructor(
    readonly reason: CanonicalCompanionPeerValidationReason,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalCompanionPeerValidationError';
  }
}

export interface IcpCompanionOutreachExecutionResult {
  disposition: 'delivered' | 'suppressed';
}

interface KnownOpenIcpDyad extends IcpOpenDyadProjection {
  peerContactId: string;
  peerDisplayLabel: string;
}

interface KnownIcpDyadLifecycle extends IcpDyadLifecycleProjection {
  peerContactId: string;
  peerDisplayLabel: string;
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
  companionListOpenDyads(): Promise<IcpOpenDyadProjection[]>;
  companionListDyads(): Promise<IcpDyadLifecycleProjection[]>;
  companionTransitionDyad(input: {
    dyadId: string;
    expectedRevision: number;
    action: IcpDyadSideAction;
  }): Promise<IcpDyadLifecycleResult>;
  companionPrepareDyadContinuation(input: {
    dyadId: string;
    deliveryId: string;
    conversationId: string;
    peerContactId: string;
    initiationSource: IcpInitiationSource;
    sourceDyadId?: string;
  }): Promise<import('../../boundary/gateway/icp-autonomy-contract.js').IcpDyadContinuationPrepareResult>;
}

export interface IcpTargetChannelCommandPort {
  execute(input: {
    permit: IcpInitiationPermit;
    rootInitiationId: string;
    peerContactId: string;
    continuationTaskKind?: IcpContinuationTaskKind;
  }): Promise<IcpCompanionOutreachExecutionResult>;
  executeContinuation?(input: {
    authorization: import('../../boundary/gateway/icp-autonomy-contract.js').IcpDyadContinuationAuthorization;
    peerContactId: string;
    privateIntent: string;
    continuationTaskKind?: IcpContinuationTaskKind;
  }): Promise<IcpCompanionOutreachExecutionResult>;
  executeHumanRelay?(input: {
    authorization: import('../../boundary/gateway/icp-autonomy-contract.js').IcpDyadContinuationAuthorization;
    peerContactId: string;
    capsule: import('./human-relay-capsule.js').HumanRelayIntentCapsule;
  }): Promise<IcpCompanionOutreachExecutionResult>;
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
  listOpenDyads(): Promise<KnownOpenIcpDyad[]>;
  listDyads(): Promise<KnownIcpDyadLifecycle[]>;
  transitionDyad(input: {
    dyadId: string;
    expectedRevision: number;
    action: IcpDyadSideAction;
  }): Promise<IcpDyadLifecycleResult>;
  inspectOpenDyad(dyadId: string): Promise<KnownOpenIcpDyad>;
  executeDyadContinuation(input: {
    dyadId: string;
    deliveryId: string;
    conversationId: string;
    privateIntent: string;
    initiationSource: IcpInitiationSource;
    sourceDyadId?: string;
    continuationTaskKind?: IcpContinuationTaskKind;
  }, isExecutionAuthorized?: () => boolean): Promise<IcpCompanionOutreachExecutionResult>;
  executeHumanRelay(input: {
    dyadId: string;
    deliveryId: string;
    conversationId: string;
    capsule: import('./human-relay-capsule.js').HumanRelayIntentCapsule;
  }, isExecutionAuthorized?: () => boolean): Promise<IcpCompanionOutreachExecutionResult>;
  executeCompanionOutreach(
    contactId: string,
    permitId: string,
    candidateOrigin?: IcpAutonomyCandidateOrigin,
    isExecutionAuthorized?: () => boolean,
  ): Promise<IcpCompanionOutreachExecutionResult>;
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
      'not_machine_intelligence',
      'contact is not a canonical machine-intelligence peer',
    );
  }
  const companionIds = collectCompanionIds(contact);
  if (companionIds.length !== 1 || !isRfc4122Uuid(companionIds[0])) {
    throw new CanonicalCompanionPeerValidationError(
      'invalid_companion_identity',
      'contact does not have exactly one canonical companion identity',
    );
  }
  const peerCompanionId = companionIds[0];
  const reverse = await contactStore.getByChannelIdentity('companion', peerCompanionId);
  if (!reverse || reverse.id !== contact.id || !reverse.isMachineIntelligence) {
    throw new CanonicalCompanionPeerValidationError(
      'reverse_identity_mismatch',
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

  const listOpenDyads = async (): Promise<KnownOpenIcpDyad[]> => {
    const [projections, contacts] = await Promise.all([
      input.gateway.companionListOpenDyads(),
      input.contactStore.listAll(),
    ]);
    const peers = new Map<string, KnownCompanionPeer>();
    for (const contact of contacts) {
      try {
        const peer = await resolveCanonicalKnownPeer(input.contactStore, contact);
        if (peers.has(peer.peerCompanionId)) {
          throw new Error('ambiguous canonical companion contact authority');
        }
        peers.set(peer.peerCompanionId, peer);
      } catch (error) {
        if (!(error instanceof CanonicalCompanionPeerValidationError)) throw error;
      }
    }
    const dyads: KnownOpenIcpDyad[] = [];
    for (const projection of projections) {
      const peer = peers.get(projection.peerCompanionId);
      if (!peer) continue;
      dyads.push({
        ...projection,
        peerContactId: peer.contactId,
        peerDisplayLabel: peer.displayName,
      });
    }
    return dyads;
  };

  const listDyads = async (): Promise<KnownIcpDyadLifecycle[]> => {
    const [projections, contacts] = await Promise.all([
      input.gateway.companionListDyads(),
      input.contactStore.listAll(),
    ]);
    const peers = new Map<string, KnownCompanionPeer>();
    for (const contact of contacts) {
      try {
        const peer = await resolveCanonicalKnownPeer(input.contactStore, contact);
        if (peers.has(peer.peerCompanionId)) throw new Error('ambiguous canonical companion contact authority');
        peers.set(peer.peerCompanionId, peer);
      } catch (error) {
        if (!(error instanceof CanonicalCompanionPeerValidationError)) throw error;
      }
    }
    return projections.flatMap(projection => {
      const peer = peers.get(projection.peerCompanionId);
      return peer ? [{
        ...projection,
        peerContactId: peer.contactId,
        peerDisplayLabel: peer.displayName,
      }] : [];
    });
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
    listOpenDyads,
    listDyads,
    async transitionDyad(transition) {
      if (!isRfc4122Uuid(transition.dyadId)) {
        throw new Error('dyad_id must be a lowercase RFC-4122 UUID');
      }
      const owned = (await listDyads()).find(dyad => dyad.dyadId === transition.dyadId);
      if (!owned) return { outcome: 'unavailable', reasonCode: 'dyad_not_found' };
      if (owned.lifecycleRevision !== transition.expectedRevision) {
        return { outcome: 'unavailable', reasonCode: 'dyad_stale_revision' };
      }
      return await input.gateway.companionTransitionDyad(transition);
    },
    async inspectOpenDyad(dyadId) {
      if (!isRfc4122Uuid(dyadId)) throw new Error('dyad_id must be a lowercase RFC-4122 UUID');
      const matches = (await listOpenDyads()).filter(dyad => dyad.dyadId === dyadId);
      if (matches.length !== 1) throw new Error('open dyad is unavailable or not owned by this companion');
      return matches[0]!;
    },
    async executeDyadContinuation(continuation, isExecutionAuthorized) {
      const dyad = await this.inspectOpenDyad(continuation.dyadId);
      if (isExecutionAuthorized && !isExecutionAuthorized()) {
        throw new Error('companion continuation authorization changed before broker preparation');
      }
      const prepared = await input.gateway.companionPrepareDyadContinuation({
        dyadId: dyad.dyadId,
        deliveryId: continuation.deliveryId,
        conversationId: continuation.conversationId,
        peerContactId: dyad.peerContactId,
        initiationSource: continuation.initiationSource,
        ...(continuation.sourceDyadId ? { sourceDyadId: continuation.sourceDyadId } : {}),
      });
      if (prepared.status !== 'authorized') {
        throw new Error(`companion continuation ${prepared.status}: ${prepared.reasonCode}`);
      }
      if (prepared.authorization.peerCompanionId !== dyad.peerCompanionId
        || prepared.authorization.channelId !== dyad.channelId) {
        throw new Error('companion continuation authorization changed its canonical destination');
      }
      if (isExecutionAuthorized && !isExecutionAuthorized()) {
        throw new Error('companion continuation authorization changed before target-channel turn');
      }
      if (!input.command.executeContinuation) {
        throw new Error('ICP target-channel continuation command is not registered');
      }
      return await input.command.executeContinuation({
        authorization: prepared.authorization,
        peerContactId: dyad.peerContactId,
        privateIntent: continuation.privateIntent,
        ...(continuation.continuationTaskKind
          ? { continuationTaskKind: continuation.continuationTaskKind }
          : {}),
      });
    },
    async executeHumanRelay(relay, isExecutionAuthorized) {
      const dyad = await this.inspectOpenDyad(relay.dyadId);
      if (isExecutionAuthorized && !isExecutionAuthorized()) {
        throw new Error('human relay authorization changed before broker preparation');
      }
      const prepared = await input.gateway.companionPrepareDyadContinuation({
        dyadId: dyad.dyadId,
        deliveryId: relay.deliveryId,
        conversationId: relay.conversationId,
        peerContactId: dyad.peerContactId,
        initiationSource: 'foreground',
      });
      if (prepared.status !== 'authorized') {
        throw new Error(`human relay ${prepared.status}: ${prepared.reasonCode}`);
      }
      if (prepared.authorization.peerCompanionId !== dyad.peerCompanionId
        || prepared.authorization.channelId !== dyad.channelId) {
        throw new Error('human relay authorization changed its canonical destination');
      }
      if (isExecutionAuthorized && !isExecutionAuthorized()) {
        throw new Error('human relay authorization changed before target-channel turn');
      }
      if (!input.command.executeHumanRelay) {
        throw new Error('ICP target-channel human relay command is not registered');
      }
      return await input.command.executeHumanRelay({
        authorization: prepared.authorization,
        peerContactId: dyad.peerContactId,
        capsule: relay.capsule,
      });
    },
    async executeCompanionOutreach(
      contactId,
      permitId,
      candidateOrigin,
      isExecutionAuthorized,
    ) {
      const { peer, handoff } = await prepare(contactId, permitId);
      const parsedOrigin = candidateOrigin === undefined
        ? undefined
        : parseIcpAutonomyCandidateOrigin(candidateOrigin);
      if (parsedOrigin
        && (handoff.permit.candidateId !== parsedOrigin.candidateId
          || handoff.rootInitiationId !== parsedOrigin.rootInitiationId
          || handoff.permit.provenanceRef !== parsedOrigin.provenanceRef)) {
        throw new Error('companion outreach candidate origin does not match its permit episode');
      }
      if (isExecutionAuthorized && !isExecutionAuthorized()) {
        throw new Error('companion outreach authorization changed during broker preparation');
      }
      return await input.command.execute({
        permit: handoff.permit,
        rootInitiationId: handoff.rootInitiationId,
        peerContactId: peer.contactId,
        ...(parsedOrigin?.continuationTaskKind
          ? { continuationTaskKind: parsedOrigin.continuationTaskKind }
          : {}),
      });
    },
  };
}
