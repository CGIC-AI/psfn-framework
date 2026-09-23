import { describe, expect, it } from 'vitest';
import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { ResolvedAuthorContext } from '../runtime-context.js';
import { isObserverSocialContactTurn } from './observer-social-interaction.js';

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
    expect(isObserverSocialContactTurn(message, { ...author, actorKind }, undefined))
      .toBe(true);
  });
  it.each(['system', 'unknown'] as const)('rejects %s even with a bound contact', actorKind => {
    expect(isObserverSocialContactTurn(message, { ...author, actorKind }, undefined)).toBe(false);
  });
  it('rejects unresolved speakers and system-role peer initiation', () => {
    expect(isObserverSocialContactTurn(message, { ...author, canonicalContactKey: undefined }, undefined)).toBe(false);
    expect(isObserverSocialContactTurn(message, { ...author, speakerRole: 'system' }, undefined)).toBe(false);
  });
  it.each(['reflection', 'heartbeat', 'maintenance', 'journal'])('rejects %s task evidence', task => {
    expect(isObserverSocialContactTurn(message, author, task)).toBe(false);
  });
  it('rejects self-directed channels, private generation triggers, and contact hints alone', () => {
    expect(isObserverSocialContactTurn({ ...message, channelId: 'internal:reflection:hobby' }, author, undefined)).toBe(false);
    expect(isObserverSocialContactTurn({ ...message, authorId: 'system:social-outreach' }, author, undefined)).toBe(false);
    expect(isObserverSocialContactTurn({ ...message, routing: { privateTurnTrigger: true } }, author, undefined)).toBe(false);
    expect(isObserverSocialContactTurn({ ...message, routing: { canonicalContactId: 'hint-only' } }, { ...author, canonicalContactKey: undefined }, undefined)).toBe(false);
  });
});
