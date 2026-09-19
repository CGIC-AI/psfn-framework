import { describe, expect, it } from 'vitest';
import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { ResolvedAuthorContext } from '../runtime-context.js';
import { resolveObserverSocialInteraction } from './observer-social-interaction.js';

const message: SubstrateMessage = {
  id: 'incoming-hobby-turn', authorId: 'transport-person', authorName: 'Morgan',
  channelId: 'hobby-room', channelType: 'discord', content: 'I finished my model sailboat.',
  timestamp: new Date('2026-01-02T12:00:00Z'),
};
const author: ResolvedAuthorContext = {
  trustLevel: 'regular', speakerRole: 'user', actorKind: 'human',
  resolvedUserName: 'Morgan', canonicalContactKey: 'contact-morgan', continuityFallbackKeys: [],
};
describe('observer social authority', () => {
  it.each(['human', 'machine_intelligence'] as const)('admits resolved incoming %s speakers', actorKind => {
    expect(resolveObserverSocialInteraction(message, { ...author, actorKind }, undefined))
      .toEqual({ kind: 'canonical_contact', contactId: 'contact-morgan' });
  });
  it.each(['system', 'unknown'] as const)('rejects %s even with a bound contact', actorKind => {
    expect(resolveObserverSocialInteraction(message, { ...author, actorKind }, undefined)).toBeUndefined();
  });
  it('rejects unresolved speakers and system-role peer initiation', () => {
    expect(resolveObserverSocialInteraction(message, { ...author, canonicalContactKey: undefined }, undefined)).toBeUndefined();
    expect(resolveObserverSocialInteraction(message, { ...author, speakerRole: 'system' }, undefined)).toBeUndefined();
  });
  it.each(['reflection', 'heartbeat', 'maintenance', 'journal'])('rejects %s task evidence', task => {
    expect(resolveObserverSocialInteraction(message, author, task)).toBeUndefined();
  });
  it('rejects self-directed channels, private generation triggers, and contact hints alone', () => {
    expect(resolveObserverSocialInteraction({ ...message, channelId: 'internal:reflection:hobby' }, author, undefined)).toBeUndefined();
    expect(resolveObserverSocialInteraction({ ...message, authorId: 'system:social-outreach' }, author, undefined)).toBeUndefined();
    expect(resolveObserverSocialInteraction({ ...message, routing: { privateTurnTrigger: true } }, author, undefined)).toBeUndefined();
    expect(resolveObserverSocialInteraction({ ...message, routing: { canonicalContactId: 'hint-only' } }, { ...author, canonicalContactKey: undefined }, undefined)).toBeUndefined();
  });
});
