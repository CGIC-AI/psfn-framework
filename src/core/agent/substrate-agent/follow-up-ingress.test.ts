import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { FollowUpIngressRouter } from './follow-up-ingress.js';
import { INTENTION_FOLLOW_UP_AUTHOR_ID } from '../../intention/appraisal.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';

/**
 * psfn-framework-o5wf5 (r5): a private intention whisper formed in a trusted
 * room was injected into a public room's active run, because a follow-up
 * joined whatever ordinary run was active. A follow-up now joins a run only
 * in its own conversation.
 */
function makeRouter(activeChannelId: string | null) {
  const followUp = vi.fn();
  const deferInternalFollowUp = vi.fn();
  const runFresh = vi.fn(async () => {});
  const recordUserMessage = vi.fn();
  const router = new FollowUpIngressRouter({
    agent: { followUp },
    turnRunReservation: fromAny({
      runIngress: async (_owner: unknown, run: (lease: { deferredFromExclusive: boolean }) => Promise<void>) =>
        await run({ deferredFromExclusive: false }),
    }),
    turnQueueIngress: fromAny({
      canQueueIntoActiveOrdinaryRun: () => activeChannelId !== null,
      deferInternalFollowUp,
      reserveFreshOrdinarySlot: () => ({ run: runFresh, dispose: () => {} }),
    }),
    turnSupportRuntime: fromAny({
      getActiveTurnSessionIdentity: () => (activeChannelId
        ? { sourceChannelId: activeChannelId, logicalSessionId: `session:${activeChannelId}` }
        : null),
      recordUserMessage,
      recordSystemMessage: vi.fn(),
    }),
    completionNotices: fromAny({ register: vi.fn() }),
    requireActiveTurnSessionIdentity: () => ({ sourceChannelId: activeChannelId ?? '', logicalSessionId: 's' }),
    resolveAuthorContext: async () => fromAny({
      trustLevel: 'regular', speakerRole: 'user', actorKind: 'human', resolvedUserName: 'Reviewer', continuityFallbackKeys: [],
    }),
  });
  return { router, followUp, deferInternalFollowUp, runFresh, recordUserMessage };
}

function message(channelId: string, authorId: string, content: string): SubstrateMessage {
  return {
    id: `m-${channelId}`,
    channelId,
    channelType: 'api',
    authorId,
    authorName: 'Whisper',
    content,
    timestamp: new Date(),
  };
}

describe('follow-up ingress conversation routing (o5wf5)', () => {
  it('holds a whisper from another room for that room instead of the active public run', async () => {
    const { router, followUp, deferInternalFollowUp } = makeRouter('api:public-room');
    await router.followUp(message('api:trusted-room', INTENTION_FOLLOW_UP_AUTHOR_ID, 'private note about a named person'));

    expect(followUp).not.toHaveBeenCalled();
    expect(deferInternalFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'internalWhisper', content: 'private note about a named person' }),
      'api:trusted-room',
    );
  });

  it('still delivers a whisper into the active run of its own room', async () => {
    const { router, followUp, deferInternalFollowUp } = makeRouter('api:trusted-room');
    await router.followUp(message('api:trusted-room', INTENTION_FOLLOW_UP_AUTHOR_ID, 'note for this room'));

    expect(followUp).toHaveBeenCalledWith(expect.objectContaining({ type: 'internalWhisper', content: 'note for this room' }));
    expect(deferInternalFollowUp).not.toHaveBeenCalled();
  });

  it('runs another conversation\'s follow-up as its own turn instead of joining the active run', async () => {
    const { router, followUp, runFresh, recordUserMessage } = makeRouter('api:public-room');
    const review = message('internal:contact-trust-review', 'scheduler', 'trust review of a contact');
    await router.followUp(review);

    expect(followUp).not.toHaveBeenCalled();
    expect(recordUserMessage).not.toHaveBeenCalled();
    expect(runFresh).toHaveBeenCalledWith(review);
  });
});
