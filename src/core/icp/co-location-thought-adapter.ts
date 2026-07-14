import { createHash } from 'node:crypto';

import { composeCompanionRoomChannelId } from '../../shared/contracts/companion-channels.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { ContactStorePort } from '../contacts/contact-store-port.js';
import {
  recordWeightedThought,
  type WeightedThoughtStorePort,
} from '../intention/weighted-thought-store-port.js';
import type { WeightedThoughtLifecycleConfig } from '../intention/weighted-thoughts.js';

const log = createComponentLogger('IcpCoLocationThought');

function thoughtId(input: {
  peerCompanionId: string;
  siteId: string;
  placeId: string;
}): string {
  const digest = createHash('sha256')
    .update(`${input.peerCompanionId}\0${input.siteId}\0${input.placeId}`)
    .digest('hex')
    .slice(0, 24);
  return `icp-colocation:${digest}`;
}

/**
 * Co-location is evidence, never a greeting trigger. This adapter performs
 * only canonical contact resolution and a low-weight durable thought write;
 * it has no model or candidate-broker dependency by design.
 */
export function registerIcpCoLocationThoughtAdapter(input: {
  eventBus: EventBus;
  localCompanionId: string;
  contactStore: Pick<ContactStorePort, 'getByChannelIdentity'>;
  thoughtStore: Pick<WeightedThoughtStorePort, 'getById' | 'save'>;
  lifecycleConfig: WeightedThoughtLifecycleConfig;
  now?: () => number;
}): () => void {
  const now = input.now ?? Date.now;
  return input.eventBus.on('presence.companion.co_located', async event => {
    if (event.observerCompanionId !== input.localCompanionId) return;
    const contact = await input.contactStore.getByChannelIdentity('companion', event.companionId);
    if (!contact?.isMachineIntelligence) {
      log.warn('Co-location thought skipped: peer has no canonical MI contact', {
        peerCompanionId: event.companionId,
        placeId: event.placeId,
      });
      return;
    }
    const id = thoughtId({
      peerCompanionId: event.companionId,
      siteId: event.siteId,
      placeId: event.placeId,
    });
    await recordWeightedThought(input.thoughtStore, input.lifecycleConfig, {
      id,
      content: `A peer companion is also present at ${event.placeId}.`,
      source: 'icp_co_location',
      thoughtClass: 'trivial',
      contactId: contact.id,
      relationshipMultiplier: 0.25,
      emotionalIntensity: 0,
      provenance: {
        coLocationRef: `${event.companionId}:${event.siteId}:${event.placeId}:${event.since}`,
        sourceChannelId: composeCompanionRoomChannelId(event.placeId),
        sourceChannelType: 'companion',
      },
    }, now());
  });
}
