import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { ApprovalQueuePort } from '../../system/capabilities/approval-queue-port.js';
import type { ContactStorePort } from './contact-store-port.js';
import type { ChannelPrivacyLevel } from './types.js';
import type { ContactBlockListStore } from '../cogsec/contact-block-list.js';
import type { SelfAuthoredMutationIntakeRuntime } from '../session/intake-sink-gating.js';
import { createContactTool } from './tools.js';
import type { ContactBlockPermitInvalidationPort } from './contact-block-permit-invalidation-port.js';
import type { AgentFacingIcpAutonomyRuntime } from '../icp/agent-facing-autonomy.js';

export interface ContactRuntimeTarget {
  contactStore: ContactStorePort | null;
  registerTool: ToolRegistrar;
}

export interface ContactRuntimeIdentityLink {
  channel: string;
  userId: string;
  privacyLevel?: ChannelPrivacyLevel;
}

export interface ContactRuntimeOptions {
  bootstrapPrimaryIdentityLinks?: ContactRuntimeIdentityLink[];
  exportDir?: string;
  /**
   * Shared confirmation queue for trusted-tier promotion proposals
   * (contact action=propose_trust). Absent → propose_trust fails closed.
   */
  proposalQueue?: ApprovalQueuePort;
  /**
   * System-owned contact block list (htm9.16). Absent → contact action=block
   * and action=unblock fail closed. The gateway reads the same store to drop
   * blocked inbound before it reaches the agent.
   */
  blockList?: ContactBlockListStore;
  /** Gateway-owned invalidation that must commit before companion blocks. */
  permitInvalidation?: ContactBlockPermitInvalidationPort;
  /** Screen-then-gate runtime for contact trust mutations. */
  intake: SelfAuthoredMutationIntakeRuntime;
  peerAvailability?: Pick<AgentFacingIcpAutonomyRuntime, 'readKnownPeerAvailability'>;
}

export async function registerContactRuntime(
  target: ContactRuntimeTarget,
  contactStore: ContactStorePort,
  primaryUserId: string | undefined,
  options: ContactRuntimeOptions,
): Promise<ContactStorePort> {
  target.contactStore = contactStore;

  const trimmedPrimaryUserId = primaryUserId?.trim();
  if (trimmedPrimaryUserId && options.bootstrapPrimaryIdentityLinks?.length) {
    const primaryContact = await contactStore.resolveUserId(trimmedPrimaryUserId);
    for (const link of options.bootstrapPrimaryIdentityLinks) {
      const channel = link.channel.trim();
      const userId = link.userId.trim();
      if (!channel || !userId) continue;
      await contactStore.linkChannelIdentity(
        primaryContact.id,
        channel,
        userId,
        link.privacyLevel ? { privacyLevel: link.privacyLevel } : undefined,
      );
    }
  }

  target.registerTool(createContactTool(contactStore, {
    proposalQueue: options.proposalQueue,
    ...(options.blockList ? { blockList: options.blockList } : {}),
    ...(options.permitInvalidation ? { permitInvalidation: options.permitInvalidation } : {}),
    intake: options.intake,
    ...(options.peerAvailability ? { peerAvailability: options.peerAvailability } : {}),
  }));

  return contactStore;
}
