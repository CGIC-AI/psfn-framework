import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { ResolvedAuthorContext } from '../runtime-context.js';

/**
 * Whether this turn is live inbound contact evidence for EmoSim social
 * satiation (PR #609, folded into the vcq8v.6 social-contact key): admitted
 * speaker authority only, never the contact a self-directed, scheduled,
 * private-trigger, reflection, or testing turn is about.
 */
export function isObserverSocialContactTurn(
  message: SubstrateMessage,
  author: ResolvedAuthorContext,
  taskKind: string | undefined,
): boolean {
  return author.speakerRole === 'user'
    && (author.actorKind === 'human' || author.actorKind === 'machine_intelligence')
    && Boolean(author.canonicalContactKey?.trim())
    && !message.channelId.startsWith('internal:')
    && !message.authorId.startsWith('system:')
    && message.routing?.privateTurnTrigger !== true
    && !message.routing?.reflectionTurn
    && !message.routing?.reflectionScope
    && !message.routing?.testingHarness
    && (taskKind === undefined || taskKind === 'chat');
}
