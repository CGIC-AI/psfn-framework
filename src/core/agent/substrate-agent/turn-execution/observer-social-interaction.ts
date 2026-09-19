import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { IncomingObserverSocialInteraction } from '../../../eval/observer-sidecar/types.js';
import type { ResolvedAuthorContext } from '../runtime-context.js';

/** Use admitted speaker authority, never the contact a self-directed turn is about. */
export function resolveObserverSocialInteraction(
  message: SubstrateMessage,
  author: ResolvedAuthorContext,
  taskKind: string | undefined,
): IncomingObserverSocialInteraction | undefined {
  if (author.speakerRole !== 'user'
    || (author.actorKind !== 'human' && author.actorKind !== 'machine_intelligence')
    || !author.canonicalContactKey?.trim()
    || message.channelId.startsWith('internal:')
    || message.authorId.startsWith('system:')
    || message.routing?.privateTurnTrigger === true
    || message.routing?.reflectionTurn
    || message.routing?.reflectionScope
    || message.routing?.testingHarness
    || (taskKind !== undefined && taskKind !== 'chat')) return undefined;
  return { kind: 'canonical_contact', contactId: author.canonicalContactKey };
}
